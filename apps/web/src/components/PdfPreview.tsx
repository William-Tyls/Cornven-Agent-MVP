import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// Render locally: no native PDF plugin, external viewer, or model request.
export default function PdfPreview({
  url,
  label,
  onClose,
  onDownload,
}: {
  url: string;
  label: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rendering, setRendering] = useState(true);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    return () => {
      modal.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    const timeout = window.setTimeout(() => {
      active = false;
      controller.abort();
      void task?.destroy().catch(() => undefined);
      setError('PDF 加载超时，请关闭后重试，或下载文件查看。');
    }, 20000);
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('资源暂时不可用，请稍后重试或联系维护人员。');
        if (response.headers.get('Content-Type')?.split(';')[0] !== 'application/pdf')
          throw new Error('文件格式不正确，无法预览 PDF。');
        const data = new Uint8Array(await response.arrayBuffer());
        if (!active) return;
        task = getDocument({ data, useSystemFonts: true });
        const document = await task.promise;
        if (active) setPdf(document);
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error && cause.message.startsWith('资源')
              ? cause.message
              : 'PDF 无法加载或文件已损坏，请下载查看或联系维护人员。',
          );
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      void task?.destroy().catch(() => undefined);
    };
  }, [url]);
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${label}，第 ${page} 页`);
    surface.current!.replaceChildren(canvas);
    setRendering(true);
    const timeout = window.setTimeout(() => {
      active = false;
      render?.cancel();
      setError('页面显示超时，请关闭后重试，或下载文件查看。');
    }, 20000);
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (!active) return;
        const viewport = pdfPage.getViewport({ scale: 1.3 * zoom });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        render = pdfPage.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        await render.promise;
        if (active) {
          canvas.dataset.rendered = 'true';
          setRendering(false);
        }
      } catch {
        if (active) setError('此页无法显示，请下载文件查看或联系维护人员。');
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      render?.cancel();
      canvas.remove();
    };
  }, [pdf, page, zoom, label]);
  const busy = !pdf || rendering;
  return (
    <dialog
      ref={dialog}
      className="pdf-preview"
      aria-label={`PDF 预览：${label}`}
      onCancel={onClose}
    >
      <header className="pdf-preview__toolbar">
        <strong>{label}</strong>
        <button type="button" onClick={onClose} autoFocus>
          关闭预览
        </button>
      </header>
      <div className="pdf-preview__toolbar">
        <button
          type="button"
          disabled={busy || page <= 1 || !!error}
          onClick={() => {
            setRendering(true);
            setPage(page - 1);
          }}
        >
          上一页
        </button>
        <span aria-live="polite">{pdf ? `第 ${page} / ${pdf.numPages} 页` : '正在读取 PDF…'}</span>
        <button
          type="button"
          disabled={busy || !pdf || page >= pdf.numPages || !!error}
          onClick={() => {
            setRendering(true);
            setPage(page + 1);
          }}
        >
          下一页
        </button>
        <button
          type="button"
          aria-label="缩小"
          disabled={busy || zoom <= 0.5 || !!error}
          onClick={() => {
            setRendering(true);
            setZoom(zoom - 0.25);
          }}
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="放大"
          disabled={busy || zoom >= 2 || !!error}
          onClick={() => {
            setRendering(true);
            setZoom(zoom + 0.25);
          }}
        >
          ＋
        </button>
        <button
          type="button"
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            setDownloadError(null);
            try {
              await onDownload();
            } catch {
              setDownloadError('下载失败，请稍后重试或联系维护人员。');
            } finally {
              setDownloading(false);
            }
          }}
        >
          {downloading ? '正在下载…' : '下载 PDF'}
        </button>
      </div>
      {downloadError && <p role="alert">{downloadError}</p>}
      {error ? <p role="alert">{error}</p> : busy && <p role="status">正在加载页面…</p>}
      <div ref={surface} className="pdf-preview__surface" aria-busy={busy} hidden={!!error} />
    </dialog>
  );
}
