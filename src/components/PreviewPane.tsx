import { useEffect, useMemo, useRef, useState } from 'react';
import { BatteryFull, CellSignalFull, WifiHigh } from '@phosphor-icons/react';
import { extractTitle, stripFirstH1 } from '../markdown';
import type { ScrollSyncChannel } from '../scrollSync';
import type { Theme } from '../theme';

interface Props {
  body: string;
  theme: Theme;
  /** Whether the body contains images (shows the WeChat paste notice) */
  hasImage: boolean;
  /** Name of the current density preset, shown next to the theme name */
  densityName: string;
  /**
   * Layout-change signal (editor width and mode switching both change it):
   * a backstop for the ResizeObserver — dragging the splitter or switching
   * between side-by-side and preview forces the phone/desktop decision to
   * re-run.
   */
  resizeKey: string;
  /** Scroll-sync channel (the editor publishes, this subscribes and writes DOM) */
  sync: ScrollSyncChannel;
}

interface Anchor {
  line: number;
  top: number;
}

/** Tail blend range: the last stretch of editor travel used to converge
 *  smoothly onto the bottom of the preview */
const TAIL_BLEND = 0.18;

/**
 * Convert a source position into a preview scroll offset.
 *
 * The point is interpolation, not snapping: find the two anchors the position
 * falls between and take a linear value between their offsets, in proportion to
 * the line number. Snapping to the nearest anchor makes the preview jump a
 * paragraph at a time — that was the old stutter. Interpolated, the preview
 * follows the editor continuously.
 */
function offsetForPosition(anchors: Anchor[], position: number, end: Anchor | null): number {
  // Binary search for the last anchor with line <= position
  let lo = 0;
  let hi = anchors.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].line <= position) {
      i = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (i < 0) {
    // The position sits above the first anchor (the preview drops the duplicate
    // h1, so the opening lines have no anchor of their own): interpolate from a
    // virtual "top of content" to the first anchor, otherwise reaching it jumps
    // a long way at once

    const first = anchors[0];
    if (first.line <= 0) return 0;
    return Math.max(0, first.top * Math.min(1, Math.max(0, position / first.line)));
  }
  const cur = anchors[i];
  // Past the last anchor, attach a virtual "end of article" anchor so the tail
  // keeps interpolating instead of freezing and then jumping
  const next = anchors[i + 1] ?? (end && end.line > cur.line ? end : null);
  if (!next) return Math.max(0, cur.top);
  const span = next.line - cur.line;
  if (span <= 0) return Math.max(0, cur.top);
  const t = Math.min(1, Math.max(0, (position - cur.line) / span));
  return Math.max(0, cur.top + (next.top - cur.top) * t);
}

/**
 * Build the "source line → preview offset" anchor table.
 * `top` is relative to the top of the scrolled content (it excludes the current
 * scrollTop), so it can be reused while scrolling and only needs rebuilding
 * after the body or the layout changes.
 */
function buildAnchors(scroll: HTMLElement): Anchor[] {
  // Read every geometry value in one pass without writing DOM in between, so
  // the browser is forced through a single reflow
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
  const anchors: Anchor[] = [];
  for (const el of scroll.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(el.dataset.line);
    if (anchors.length && anchors[anchors.length - 1].line === line) continue;
    anchors.push({ line, top: el.getBoundingClientRect().top - base });
  }
  return anchors;
}

/**
 * The right-hand preview:
 * - narrow pane (<860px) → phone styling (device frame, Dynamic Island status bar)
 * - wide pane (≥860px) → desktop macOS window styling (traffic-light title bar)
 * - article head on top (title plus byline), action bar at the end of the content
 * Every style in the body HTML is inline ⇒ preview and export (the WeChat
 * paste) are identical.
 */
export default function PreviewPane({ body, theme, hasImage, densityName, resizeKey, sync }: Props) {
  const paneRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [widthMode, setWidthMode] = useState<'phone' | 'desktop'>('phone');
  const title = useMemo(() => extractTitle(body), [body]);
  /** Body used for the preview (duplicate h1 removed; exports still use the full body) */
  const previewBody = useMemo(() => (title ? stripFirstH1(body) : body), [body, title]);
  /** Date in the article head (a new Date() on every render means nothing) */
  const today = useMemo(() => new Date(), []);

  // Switch between phone and desktop as the pane's width changes
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const update = () => setWidthMode(el.getBoundingClientRect().width >= 860 ? 'desktop' : 'phone');
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Backstop refresh on a layout change (drag, mode switch)
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    setWidthMode(el.getBoundingClientRect().width >= 860 ? 'desktop' : 'phone');
  }, [resizeKey]);

  /** Anchor cache (null means it needs rebuilding) */
  const anchorsRef = useRef<Anchor[] | null>(null);
  /** Request one sync (coalesced onto a rAF); reused when the body changes */
  const scheduleRef = useRef<() => void>(() => {});

  // Editor scroll → preview scroll. None of this path goes through React:
  // subscribe to the channel → coalesce onto a frame → interpolate the anchors
  // → write scrollTop.

  useEffect(() => {
    const apply = () => {
      const scroll = scrollRef.current;
      if (!scroll) return;
      const { position, endPosition, atTop, atBottom } = sync.state;
      // Align the edges exactly, so interpolation error leaves no gap at either
      // end. Snapping at the bottom is now "the interpolation had already
      // converged there", not a jump.

      if (atBottom) {
        scroll.scrollTop = scroll.scrollHeight;
        return;
      }
      if (atTop) {
        if (scroll.scrollTop !== 0) scroll.scrollTop = 0;
        return;
      }
      let anchors = anchorsRef.current;
      if (!anchors) {
        anchors = buildAnchors(scroll);
        anchorsRef.current = anchors;
      }
      if (!anchors.length) return;
      const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const end = endPosition > 0 ? { line: endPosition, top: maxScroll } : null;
      let top = offsetForPosition(anchors, position, end);

      // Landing alignment: when the editor hits its bottom, the topmost visible
      // line is still mid-document, and the anchor-derived position falls short
      // of the preview's bottom. That gap used to be closed by "at the bottom,
      // jump to the bottom", which is why the ending lurched. Now it converges
      // over the final stretch instead.


      if (endPosition > 0) {
        const t = Math.min(1, Math.max(0, position / endPosition));
        if (t > 1 - TAIL_BLEND) {
          const w = (t - (1 - TAIL_BLEND)) / TAIL_BLEND;
          const eased = w * w * (3 - 2 * w); // smoothstep: no kink on entering the blend
          top = top + (maxScroll - top) * eased;
        }
      }
      if (Math.abs(scroll.scrollTop - top) < 0.5) return;
      scroll.scrollTop = top;
    };

    let raf = 0;
    const schedule = () => {
      // Collapse several scroll events in one frame into a single read/write
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    scheduleRef.current = schedule;
    const unsubscribe = sync.subscribe(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sync]);

  // A re-rendered body or a phone⇄desktop switch invalidates every anchor
  // offset, and calls for one realignment
  useEffect(() => {
    anchorsRef.current = null;
    scheduleRef.current();
  }, [body, widthMode]);

  // Async height changes — image decoding, font loading — invalidate them too
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      anchorsRef.current = null;
      scheduleRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the article theme in the status bar and desktop window chrome
  useEffect(() => {
    document.documentElement.style.setProperty('--art-accent', theme.accent);
    document.documentElement.style.setProperty('--art-heading', theme.heading.color);
    document.documentElement.style.setProperty('--art-ink', theme.body.color);
    document.documentElement.style.setProperty('--art-hr', theme.hr.color);
    document.documentElement.style.setProperty('--art-foot-text', theme.footnote.textColor);
    document.documentElement.style.setProperty('--art-bg', theme.body.bg ?? '#ffffff');
    document.documentElement.style.setProperty('--art-heading-font', theme.heading.font);
    return () => {
      document.documentElement.style.removeProperty('--art-accent');
      document.documentElement.style.removeProperty('--art-heading');
      document.documentElement.style.removeProperty('--art-ink');
      document.documentElement.style.removeProperty('--art-hr');
      document.documentElement.style.removeProperty('--art-foot-text');
      document.documentElement.style.removeProperty('--art-bg');
      document.documentElement.style.removeProperty('--art-heading-font');
    };
  }, [theme]);

  return (
    <section className="split-pane surface preview-side" ref={paneRef} data-width={widthMode}>
      <div className="pane-head">
        {/* What is being previewed, rather than the word "preview" — which of
            the twelve themes is on, and at which density. With the theme rail
            folded into a popover, this is the only place that still says. */}
        <span className="pane-path" title="在顶栏的「排版」里更换">
          <span className="seg last">{theme.name}</span>
          <span className="seg">{densityName}</span>
        </span>
        <div className="pane-head-right">
          {hasImage && <span className="pane-stat warn">含图片 · 建议公众号内单独上传</span>}
          <span className="pane-stat" title={widthMode === 'phone' ? '面板加宽会切到桌面版式' : '面板收窄会切回手机版式'}>
            {widthMode === 'phone' ? '手机' : '桌面'}
          </span>
        </div>
      </div>
      <div className="phone-stage scroll-thin">
        <div className="phone-frame">
          {/* iPhone side buttons (phone mode): action and volume left, power right */}
          <span className="side-btn action" aria-hidden="true"></span>
          <span className="side-btn vol-up" aria-hidden="true"></span>
          <span className="side-btn vol-down" aria-hidden="true"></span>
          <span className="side-btn power" aria-hidden="true"></span>
          <div className="phone-screen">
            {/* macOS window title bar (desktop mode) */}
            <div className="desktop-bar">
              <span className="traffic t1"></span>
              <span className="traffic t2"></span>
              <span className="traffic t3"></span>
              <span className="bar-title">文章预览 · {theme.name}</span>
            </div>
            {/* Phone status bar: Dynamic Island centered, real status icons on either side */}
            <div className="statusbar">
              <span className="time">9:41</span>
              <span className="dynamic-island" aria-hidden="true"></span>
              <span className="sb-icons" aria-hidden="true">
                <CellSignalFull size={13} weight="fill" />
                <WifiHigh size={13} weight="bold" />
                <BatteryFull size={17} weight="fill" />
              </span>
            </div>
            <div className="article-scroll scroll-thin" ref={scrollRef}>
              {/* WeChat article head: title (with a placeholder when empty) plus byline */}
              <div className="article-head">
                <h1 className="head-title">{title || '未命名文章'}</h1>
                <div className="meta">
                  <span className="author">VinsEditor</span>
                  <span className="byline">
                    {today.getFullYear()} 年 {today.getMonth() + 1} 月 {today.getDate()} 日
                  </span>
                </div>
              </div>
              <div
                className="check-body"
                ref={bodyRef}
                dangerouslySetInnerHTML={{ __html: previewBody }}
              />
              {/* Article footer: share / save / recommend / like, at the end of the content */}
              <div className="article-footer">
                <div className="actions">
                  <button className="action">分享</button>
                  <button className="action">收藏</button>
                  <button className="action">在看</button>
                  <button className="action">点赞</button>
                </div>
              </div>
            </div>
            {/* Home indicator (phone mode) */}
            <span className="home-indicator" aria-hidden="true"></span>
          </div>
        </div>
      </div>
    </section>
  );
}
