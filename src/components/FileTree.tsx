import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Broom,
  CaretDown,
  CaretRight,
  CaretUpDown,
  File as FileIcon,
  FileMd,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  Image as ImageIcon,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react";
import type { Draft, Entry } from "../store/vault";
import { isImagePath, isTextPath, parentOf } from "../store/vault";

interface Props {
  /** Absolute path of the current workspace */
  vaultDir: string;
  /** Switch workspaces (opens the native directory picker) */
  onChangeVault: () => void;
  /** The workspace's actual directory tree */
  tree: Entry[];
  /** Text files already read into memory, used for the word counts */
  drafts: Draft[];
  /** The open draft (relative path) */
  activeId: string;
  /** Image relative path → data URI, for thumbnails */
  images: Record<string, string>;
  /** Images referenced by a body (both bare names and full paths count) */
  usedImageRefs: Set<string>;
  /** Open a text file */
  onOpen: (path: string) => void;
  /** Click an image: jump to where the body references it */
  onLocateImage: (path: string) => void;
  /** A file we cannot open: hand it to the system file manager */
  onReveal: (path: string) => void;
  onNewDraft: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  /** Turn a web page into a draft, dropped into `parent` (see reader.ts) */
  onImportUrl: (parent: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
  /** Drag-move: put `path` inside the `toParent` directory (empty = root) */
  onMove: (path: string, toParent: string) => void;
  /** Sweep every image that no body references */
  onCleanupImages: () => void;
}

/** Relative time: easier to read in a list than an absolute timestamp */
function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Cache of probed dimensions: decoding once is enough, and keying on length
 *  means a replaced image invalidates itself */
const dimCache = new Map<string, { w: number; h: number }>();

function dimKey(path: string, dataUrl: string): string {
  return `${path}:${dataUrl.length}`;
}

function probeSize(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/** Strip the extension — the tree shows a text file's title, not its file name */
function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** One row: a node in the tree plus its depth */
interface Row {
  entry: Entry;
  depth: number;
}

/** What is expanded decides what gets drawn; this flattens the tree into rows */
function toRows(
  entries: Entry[],
  expanded: Set<string>,
  depth = 0,
  out: Row[] = [],
): Row[] {
  for (const entry of entries) {
    out.push({ entry, depth });
    if (entry.isDir && entry.children && expanded.has(entry.path)) {
      toRows(entry.children, expanded, depth + 1, out);
    }
  }
  return out;
}

/** Where the context menu is, and what it targets */
interface Menu {
  x: number;
  y: number;
  entry: Entry | null; // null = empty space, so the target is the workspace root
}

/**
 * File tree panel: shows what is actually in the workspace folder.
 *
 * A workspace is an ordinary folder, so the tree is a real tree rather than
 * two fixed groups: subdirectories, images and other file types all listed as
 * they are, with create / rename / delete / drag-move going straight to disk.
 *
 * The drag-move below is plain HTML5 drag and drop, and it only works because
 * `dragDropEnabled` is false in tauri.conf.json. Left at its default, WebView2
 * hands every drag to Tauri's own native handler before the page sees it, and
 * on Windows — only there — dragstart/dragover/drop never fire at all: rows
 * refuse to pick up, and an image dropped on the editor does nothing. JSON has
 * nowhere to write that down, so it is written down here.
 */
export default function FileTree({
  vaultDir,
  onChangeVault,
  tree,
  drafts,
  activeId,
  images,
  usedImageRefs,
  onOpen,
  onLocateImage,
  onReveal,
  onNewDraft,
  onNewFolder,
  onImportUrl,
  onRename,
  onDelete,
  onMove,
  onCleanupImages,
}: Props) {
  /** Expanded directories. All collapsed by default; opening a draft expands
   *  the whole path down to it */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  /** The item currently being dragged */
  const [dragPath, setDragPath] = useState<string | null>(null);
  /** Which directory it is over (empty = root, null = not over a valid target) */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Read the clock once at mount rather than on every render */
  const [now] = useState(() => Date.now());

  /** The open draft has to be visible: expand every directory above it */
  useEffect(() => {
    if (!activeId.includes("/")) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const segs = activeId.split("/");
      for (let i = 1; i < segs.length; i++)
        next.add(segs.slice(0, i).join("/"));
      return next;
    });
  }, [activeId]);

  useEffect(() => {
    if (renamingPath) renameInputRef.current?.select();
  }, [renamingPath]);

  // Click elsewhere or press Esc to close the context menu
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // The menu lives in a portal on <body>, so it is measured against the window:
  // if it would run off the right or bottom edge, flip it back over the cursor.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    const pad = 8;
    const { width, height } = el.getBoundingClientRect();
    const x =
      menu.x + width + pad > window.innerWidth
        ? Math.max(pad, menu.x - width)
        : menu.x;
    const y =
      menu.y + height + pad > window.innerHeight
        ? Math.max(pad, window.innerHeight - height - pad)
        : menu.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.transformOrigin = `${x < menu.x ? "right" : "left"} ${y < menu.y ? "bottom" : "top"}`;
  }, [menu]);

  const rows = useMemo(() => toRows(tree, expanded), [tree, expanded]);
  const draftById = useMemo(
    () => new Map(drafts.map((d) => [d.id, d])),
    [drafts],
  );

  /** Dimensions are decoded asynchronously; bump this counter once the cache
   *  fills to trigger a re-layout */
  const [dimTick, setDimTick] = useState(0);
  // Only decode what is currently on screen: nobody is looking at the images
  // inside a collapsed folder, so they are not worth a decode
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let added = false;
      for (const { entry } of rows) {
        const dataUrl = images[entry.path];
        if (!dataUrl) continue;
        const key = dimKey(entry.path, dataUrl);
        if (dimCache.has(key)) continue;
        const size = await probeSize(dataUrl);
        if (cancelled) return;
        if (size) {
          dimCache.set(key, size);
          added = true;
        }
      }
      if (added && !cancelled) setDimTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, images]);

  /** Read an already-probed size. dimTick is only the "cache grew" signal and
   *  takes no part in the computation */
  const dimOf = useMemo(
    () => (path: string, dataUrl: string) =>
      dimCache.get(dimKey(path, dataUrl)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dimTick],
  );

  /** How many images no body references — the cleanup entry only appears when
   *  there is something to clean */
  const unusedImages = useMemo(
    () =>
      Object.keys(images).filter((p) => {
        const name = p.split("/").pop() ?? p;
        return !usedImageRefs.has(name) && !usedImageRefs.has(p);
      }),
    [images, usedImageRefs],
  );

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startRename = (entry: Entry) => {
    setRenamingPath(entry.path);
    setRenameValue(
      entry.isDir || !isTextPath(entry.path) ? entry.name : stemOf(entry.name),
    );
  };

  const submitRename = () => {
    if (renamingPath && renameValue.trim())
      onRename(renamingPath, renameValue.trim());
    setRenamingPath(null);
    setRenameValue("");
  };

  /** Click a row: folders toggle, text opens in the editor, images jump to
   *  their reference, anything else goes to the system */
  const activate = (entry: Entry) => {
    if (entry.isDir) toggle(entry.path);
    else if (isTextPath(entry.path)) onOpen(entry.path);
    else if (isImagePath(entry.path)) onLocateImage(entry.path);
    else onReveal(entry.path);
  };

  /** Dropping onto a file means its directory — the gesture means "put it at
   *  this level" */
  const dropDirOf = (entry: Entry) =>
    entry.isDir ? entry.path : parentOf(entry.path);

  const finishDrop = (toParent: string) => {
    const from = dragPath;
    setDragPath(null);
    setDropTarget(null);
    if (!from) return;
    // Neither a no-op move nor dragging a directory into itself (which would
    // take the whole subtree with it) needs to bother the disk
    if (
      parentOf(from) === toParent ||
      toParent === from ||
      toParent.startsWith(`${from}/`)
    )
      return;
    onMove(from, toParent);
  };

  const renderRow = ({ entry, depth }: Row) => {
    const { path, name, isDir } = entry;
    const active = path === activeId;
    const indent = { paddingLeft: 6 + depth * 11 };

    if (renamingPath === path) {
      return (
        <div key={path} className="tree-file renaming" style={indent}>
          {isDir ? <Folder size={14} /> : <FileMd size={14} />}
          <input
            ref={renameInputRef}
            className="tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") setRenamingPath(null);
            }}
            onBlur={submitRename}
          />
        </div>
      );
    }

    const dataUrl = images[path];
    const draft = draftById.get(path);
    const dim = dataUrl ? dimOf(path, dataUrl) : undefined;
    const unusedImage = !!dataUrl && unusedImages.includes(path);

    let icon = <FileIcon size={14} />;
    if (isDir)
      icon = expanded.has(path) ? (
        <FolderOpen size={14} />
      ) : (
        <Folder size={14} />
      );
    else if (isTextPath(path)) icon = <FileMd size={14} />;
    else if (dataUrl)
      icon = <img className="tree-thumb" src={dataUrl} alt="" />;
    else if (isImagePath(path)) icon = <ImageIcon size={14} />;

    // Single line per row, so the secondary column has to be short: the full
    // story lives in the row's title attribute.
    let meta = "";
    let full = path;
    if (isDir) meta = `${entry.children?.length ?? 0} 项`;
    else if (draft) {
      const words = draft.content.replace(/\s/g, "").length;
      meta = words > 999 ? `${(words / 1000).toFixed(1)}k 字` : `${words} 字`;
      full = `${path}\n${words} 字 · ${relativeTime(entry.updatedAt, now)}`;
    } else if (dataUrl) {
      meta = formatBytes(entry.size);
      full = `${path}\n${dim ? `${dim.w}×${dim.h} · ` : ""}${formatBytes(entry.size)}${unusedImage ? " · 还没有草稿引用它" : ""}`;
    } else if (!isTextPath(path)) {
      meta = formatBytes(entry.size);
      full = `${path} — 右键有更多操作`;
    }

    return (
      <div
        key={path}
        className={[
          "tree-file",
          active ? "active" : "",
          unusedImage ? "unused" : "",
          dragPath === path ? "dragging" : "",
          // Highlight only the folder that would actually catch it, or every
          // sibling file at that level lights up too
          isDir && dragPath && dropTarget === path ? "drop-into" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="treeitem"
        aria-selected={active}
        aria-expanded={isDir ? expanded.has(path) : undefined}
        draggable
        onDragStart={(e) => {
          setDragPath(path);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", path);
        }}
        onDragEnd={() => {
          setDragPath(null);
          setDropTarget(null);
        }}
        onDragOver={(e) => {
          if (!dragPath) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          setDropTarget(dropDirOf(entry));
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          finishDrop(dropDirOf(entry));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY, entry });
        }}
      >
        <button
          className="tree-file-main"
          style={indent}
          onClick={() => activate(entry)}
          title={full}
        >
          {isDir ? (
            expanded.has(path) ? (
              <CaretDown size={11} weight="bold" className="tree-caret" />
            ) : (
              <CaretRight size={11} weight="bold" className="tree-caret" />
            )
          ) : (
            <span className="tree-caret" />
          )}
          {icon}
          <span className="tree-file-name">
            {isTextPath(path) ? stemOf(name) : name}
          </span>
          {unusedImage && (
            <span className="tree-dot-unused" title="还没有草稿引用它" />
          )}
        </button>
        {meta && <span className="tree-file-meta">{meta}</span>}
        <span className="tree-file-actions">
          <button
            title="重命名"
            aria-label={`重命名 ${name}`}
            onClick={() => startRename(entry)}
          >
            <PencilSimple size={12} />
          </button>
          <button
            title="删除"
            aria-label={`删除 ${name}`}
            onClick={() => onDelete(path)}
          >
            <Trash size={12} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <nav className="file-tree surface" aria-label="文件">
      <div className="tree-head">
        {/* The title slot shows the workspace folder name — with two workspaces
            open at once, this is the only thing that says which one you are in */}
        <button
          className="tree-vault"
          title={`当前工作区：${vaultDir}\n点击换一个文件夹`}
          aria-label="切换工作区"
          onClick={onChangeVault}
        >
          <FolderOpen size={13} weight="fill" />
          <span className="tree-vault-name">
            {vaultDir.split("/").filter(Boolean).pop() ?? "工作区"}
          </span>
          <CaretUpDown size={11} weight="bold" className="tree-vault-caret" />
        </button>
        <button
          className="ghost-btn"
          title="新建草稿"
          aria-label="新建草稿"
          onClick={() => onNewDraft("")}
        >
          <FilePlus size={14} weight="bold" />
        </button>
        <button
          className="ghost-btn"
          title="新建文件夹"
          aria-label="新建文件夹"
          onClick={() => onNewFolder("")}
        >
          <FolderPlus size={14} weight="bold" />
        </button>
        {/* Also a way of creating a draft, so it sits with the other two */}
        <button
          className="ghost-btn"
          title="从链接导入：把一个网页转成草稿"
          aria-label="从链接导入"
          onClick={() => onImportUrl("")}
        >
          <Globe size={14} weight="bold" />
        </button>
      </div>

      {/* Empty space is a drop target too: dropping here moves back to the root */}
      <div
        className={`tree-body scroll-thin ${dropTarget === "" && dragPath ? "drop-into" : ""}`}
        role="tree"
        aria-label="文件"
        onDragOver={(e) => {
          if (!dragPath) return;
          e.preventDefault();
          setDropTarget("");
        }}
        onDrop={(e) => {
          e.preventDefault();
          finishDrop("");
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {rows.length === 0 ? (
          <p className="tree-empty">
            这个文件夹还是空的。新建一篇草稿，或者直接把 .md 拷进来。
          </p>
        ) : (
          rows.map(renderRow)
        )}

        {unusedImages.length > 0 && (
          <button className="tree-cleanup" onClick={onCleanupImages}>
            <Broom size={13} />
            清理 {unusedImages.length} 张未引用图片
          </button>
        )}
      </div>

      {/* Rendered on <body>: the panel is a frosted `.surface`, and its
          backdrop-filter makes it the containing block for fixed children —
          which would both offset the menu and clip it to the sidebar */}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="popover tree-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* The target: a directory is itself, a file is the level it sits in */}
            {(() => {
              const parent = menu.entry
                ? menu.entry.isDir
                  ? menu.entry.path
                  : parentOf(menu.entry.path)
                : "";
              const entry = menu.entry;
              return (
                <>
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      onNewDraft(parent);
                    }}
                  >
                    <FilePlus size={14} className="menu-icon" />
                    新建草稿
                  </button>
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      onNewFolder(parent);
                    }}
                  >
                    <FolderPlus size={14} className="menu-icon" />
                    新建文件夹
                  </button>
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      onImportUrl(parent);
                    }}
                  >
                    <Globe size={14} className="menu-icon" />
                    从链接导入
                  </button>
                  {entry && (
                    <>
                      <div className="menu-divider" />
                      <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          startRename(entry);
                        }}
                      >
                        <PencilSimple size={14} className="menu-icon" />
                        重命名
                      </button>
                      <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          onReveal(entry.path);
                        }}
                      >
                        <FolderOpen size={14} className="menu-icon" />
                        在文件管理器中显示
                      </button>
                      <button
                        className="menu-item"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          onDelete(entry.path);
                        }}
                      >
                        <Trash size={14} className="menu-icon" />
                        删除
                      </button>
                    </>
                  )}
                </>
              );
            })()}
          </div>,
          document.body,
        )}
    </nav>
  );
}
