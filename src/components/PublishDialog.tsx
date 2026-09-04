import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, CheckCircle, GearSix, PaperPlaneTilt, Stack, X } from '@phosphor-icons/react';
import { prepareImage } from '../images';
import { publishToDraft, type DraftTarget } from '../publish';
import { isConfigured, testConnection } from '../wechat';
import { patchWechatConfig, useWechatConfig } from '../store/wechatConfig';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Default article title (first H1 in the body, falling back to the draft name) */
  defaultTitle: string;
  /** Render the body HTML now — the preview runs off a deferred value, and a
   *  push has to re-render from the current body */
  buildHtml: () => Promise<string>;
  onFlash: (msg: string) => void;
  /** Credentials live in the settings dialog now, so this one has to be able
   *  to send you there when they are missing */
  onOpenSettings: () => void;
  /**
   * Set when this push should overwrite a draft picked in the drafts box
   * instead of creating a new one. Null is the ordinary "push a new draft" case.
   */
  target: DraftTarget | null;
  /** Digest as it stands on the target draft, so an update does not blank it */
  targetDigest: string;
  /** Go pick a draft to overwrite */
  onOpenDraftBox: () => void;
  /** Drop the target and go back to creating a new draft */
  onClearTarget: () => void;
}

/**
 * Push straight to the WeChat drafts box.
 *
 * The push uploads every image in the body to WeChat first and swaps in the
 * mmbiz address. That step cannot be skipped: the API does not accept data
 * URIs, and an image pasted directly gets compressed by WeChat while one
 * uploaded through the API does not.
 *
 * Credentials are not here: they are configured once, in the settings dialog,
 * and left alone. What stays is what you decide per push — the title, the
 * summary, the cover — plus the publishing options, which are remembered as
 * defaults but are still worth a look each time.
 */
export default function PublishDialog({
  open,
  onClose,
  defaultTitle,
  buildHtml,
  onFlash,
  onOpenSettings,
  target,
  targetDigest,
  onOpenDraftBox,
  onClearTarget,
}: Props) {
  const cfg = useWechatConfig();
  const [title, setTitle] = useState(defaultTitle);
  const [digest, setDigest] = useState('');
  const [cover, setCover] = useState<{ dataUrl: string; filename: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [probe, setProbe] = useState<{ kind: 'ok' | 'warn' | 'fail'; message: string } | null>(null);
  const coverRef = useRef<HTMLInputElement>(null);

  /*
   * Follow the open draft's title each time the dialog opens.
   *
   * Aiming at an existing draft changes what the fields should say: the title
   * and summary become the ones already up there, so pressing 更新 without
   * touching anything leaves them as they were rather than overwriting them
   * with whatever the local file happens to be called.
   */
  useEffect(() => {
    if (open) {
      setTitle(target?.title || defaultTitle);
      setDigest(targetDigest);
      setProbe(null);
      setProgress('');
    }
  }, [open, defaultTitle, target, targetDigest]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // No closing mid-push, or it looks cancelled while the request is still in flight
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const configured = isConfigured(cfg);

  const pickCover = async (file: File) => {
    try {
      setCover({ dataUrl: await prepareImage(file), filename: file.name });
    } catch {
      setProbe({ kind: 'fail', message: '封面图读取失败' });
    }
  };

  /** Catch common mistakes before spending a WeChat request or uploading an asset. */
  const validateArticle = (html: string): string[] => {
    const errors: string[] = [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = (doc.body.textContent ?? '').replace(/\s+/g, '').trim();
    const hasImage = doc.querySelector('img') !== null;
    if (!title.trim()) errors.push('标题不能为空');
    if (title.trim().length > 32) errors.push(`标题 ${title.trim().length} 字，超过微信 32 字上限`);
    if (!text && !hasImage) errors.push('正文不能为空');
    if (!cover && !target?.thumbMediaId && !hasImage) errors.push('缺少封面：请选择一张封面图');
    if (cfg.author.trim().length > 16) errors.push('作者超过微信 16 字上限');
    return errors;
  };

  const handlePublish = async () => {
    if (!configured) {
      setProbe({ kind: 'fail', message: '还没填公众号凭据 —— 去「设置」里填 AppID 与 AppSecret' });
      return;
    }
    setBusy(true);
    setProbe(null);
    try {
      // Render before the network probe so invalid drafts fail locally and the
      // checklist describes the exact HTML that is about to be sent.
      const html = await buildHtml();
      const localErrors = validateArticle(html);
      if (localErrors.length) {
        setProbe({ kind: 'fail', message: `发布前检查未通过：\n${localErrors.map((e) => `• ${e}`).join('\n')}` });
        return;
      }
      setProgress('正在检查微信连接…');
      const check = await testConnection(cfg);
      if (!check.canPublish) throw new Error(check.message);
      const { mediaId, updated, uploaded, smallestEdge, roundTrip } = await publishToDraft(cfg, {
        title,
        html,
        digest,
        cover: cover ?? undefined,
        onProgress: setProgress,
        target: target ?? undefined,
      });
      setProgress('');
      console.info('草稿 media_id', mediaId);
      onFlash(
        `${updated ? '已更新草稿' : '已推送到草稿箱'}（换图 ${uploaded} 张${smallestEdge ? `，最小长边 ${smallestEdge}px` : ''}）`,
      );
      if (roundTrip) {
        const { sent, stored, rendered, url } = roundTrip;
        // Judge by the size the body actually uses (/640), falling back to /0
        const shown = rendered ?? stored;
        const shrunk = shown.w < sent.w || shown.h < sent.h;
        // This verdict is the only evidence that separates "we compressed it"
        // from "WeChat compressed it", so it stays in the dialog for the user.
        // The address goes with it: an mmbiz URL carries a size segment, and
        // which one the body references decides how large readers see the image.

        setProbe({
          kind: shrunk ? 'warn' : 'ok',
          message:
            `传出 ${sent.w}×${sent.h} ${Math.round(sent.bytes / 1024)}KB\n` +
            `原图档 /0：${stored.w}×${stored.h} ${Math.round(stored.bytes / 1024)}KB\n` +
            (rendered
              ? `正文实际用的 /640：${rendered.w}×${rendered.h} ${Math.round(rendered.bytes / 1024)}KB\n`
              : '') +
            (shrunk
              ? '\n读者看到的是被规格化后的那一档 —— 这是微信对接口上传图的固定行为，改不了。\n'
              : '\n各档尺寸一致，没有被规格化。\n') +
            `\n正文引用的地址：\n${url}`,
        });
        return; // Leave the dialog open so the user can read the verdict
      }
      onClose();
    } catch (err) {
      setProgress('');
      // publishToDraft attaches the body-side wording (it has the real
      // post-swap body to work from)
      let message = err instanceof Error ? err.message : '推送失败';
      setProbe({ kind: 'fail', message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Automatic 45166 bisection: minimal body → full body → drop suspicious
   * constructs one at a time.
   * This leaves a few test drafts in the drafts box, and reminds the user to
   * clean them up when it finishes.
   */
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={target ? '更新公众号草稿' : '推送到公众号草稿箱'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{target ? '更新草稿' : '推送到草稿箱'}</h2>
          <button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={15} weight="bold" />
          </button>
        </header>

        <div className="modal-body">
          <section className="form-section">
            <div className="form-section-label">推到哪里</div>
            {/* Which draft this push lands in. A new one by default; pointed at
                an existing one, it says so plainly and offers the way back —
                overwriting the wrong article is not something to discover
                afterwards. */}
            <div className="target-line">
              {target ? (
                <>
                  <span className="target-badge">覆盖</span>
                  <span className="target-title" title={target.title}>
                    {target.title || '（无标题）'}
                  </span>
                  <button type="button" className="btn" onClick={onClearTarget} disabled={busy}>
                    <ArrowCounterClockwise size={14} weight="bold" />
                    改为新建
                  </button>
                </>
              ) : (
                <>
                  <span className="form-hint">在草稿箱里新建一篇</span>
                  <button type="button" className="btn target-pick" onClick={onOpenDraftBox} disabled={busy}>
                    <Stack size={14} weight="bold" />
                    改为更新已有草稿
                  </button>
                </>
              )}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">这一篇</div>
            <label className="field">
              <span>标题</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={32} placeholder="必填，最多 32 字" />
            </label>
            <label className="field">
              <span>摘要</span>
              <input value={digest} onChange={(e) => setDigest(e.target.value)} maxLength={120} placeholder="留空则取正文开头" />
            </label>
            <div className="field">
              <span>封面</span>
              <div className="cover-picker">
                <input
                  ref={coverRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void pickCover(file);
                    e.target.value = '';
                  }}
                />
                {cover && <img className="cover-thumb" src={cover.dataUrl} alt="封面预览" />}
                <button type="button" className="btn" onClick={() => coverRef.current?.click()}>
                  {cover ? '换一张' : '选择封面'}
                </button>
                {cover ? (
                  <button type="button" className="link-btn" onClick={() => setCover(null)}>
                    {target ? '改用草稿原封面' : '改用正文第一张图'}
                  </button>
                ) : (
                  <span className="form-hint">{target ? '不选则保留草稿原封面' : '不选则用正文第一张图'}</span>
                )}
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">推给哪个号</div>
            {/* Just enough to catch "wrong account" before the push, and one
                way through to where it is changed — the credentials themselves
                are in the settings dialog */}
            <div className="account-line">
              <span className={`account-dot ${configured ? 'ok' : 'off'}`} aria-hidden="true" />
              {configured ? (
                <>
                  <code className="account-appid">{cfg.appid}</code>
                  <span className="form-hint">凭据已配置</span>
                </>
              ) : (
                <span className="form-hint">还没填凭据，推不上去</span>
              )}
              <button type="button" className="btn account-settings" onClick={onOpenSettings}>
                <GearSix size={14} weight="bold" />
                {configured ? '改凭据' : '去填'}
              </button>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">发布设置</div>
            <label className="field">
              <span>作者</span>
              <input
                value={cfg.author}
                onChange={(e) => patchWechatConfig({ author: e.target.value })}
                maxLength={16}
                placeholder="可空，最多 16 字"
              />
            </label>
            <label className="field">
              <span>原文链接</span>
              <input
                value={cfg.sourceUrl}
                onChange={(e) => patchWechatConfig({ sourceUrl: e.target.value.trim() })}
                placeholder="可空，显示为「阅读原文」"
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={cfg.openComment}
                onChange={(e) => patchWechatConfig({ openComment: e.target.checked })}
              />
              <span>打开留言</span>
            </label>
          </section>

          <section className="publish-checklist" aria-label="发布前检查">
            <div className="form-section-label">发布前检查</div>
            <p className="form-note">点击发布时会先在本机检查内容，再连接微信；发现问题会直接告诉你怎么改。</p>
            <div className="checklist-items">
              <span>✓ 标题 ≤ 32 字</span>
              <span>✓ 正文 / 图片不为空</span>
              <span>✓ 封面可用</span>
              <span>✓ 作者 ≤ 16 字</span>
              <span>✓ 微信连接与草稿权限</span>
            </div>
          </section>
        </div>

        <footer className="modal-foot">
          {probe && (
            <span className={probe.kind === 'ok' ? 'form-ok' : probe.kind === 'warn' ? 'form-caution' : 'form-error'}>
              {probe.kind === 'ok' && <CheckCircle size={13} weight="fill" />}
              {probe.message}
            </span>
          )}
          {busy && progress && <span className="form-progress">{progress}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void handlePublish()} disabled={busy}>
            <PaperPlaneTilt size={15} weight="bold" />
            {busy ? (target ? '更新中…' : '推送中…') : target ? '更新这篇草稿' : '推到草稿箱'}
          </button>
        </footer>
      </div>
    </div>
  );
}
