import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AssistantAnswer, AssistantRequest } from '@cornven/contracts';
import {
  assistantHistoryContent,
  streamAssistant,
  getAssistantStatus,
  type AssistantStatus,
} from '../api/assistant';
import { ApiError, BASE_URL } from '../api/client';
import { downloadReport } from '../api/reports';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';
import { SettlementBreakdown } from '../components/SettlementBreakdown';

const PdfPreview = lazy(() => import('../components/PdfPreview'));

type ChatMessage = { role: 'user'; text: string } | { role: 'assistant'; answer: AssistantAnswer };
const outcomeLabel: Record<AssistantAnswer['outcome'], string> = {
  answered: 'Answered',
  refused: 'Not supported',
  insufficient_evidence: 'Not enough evidence',
  tool_error: 'Could not complete',
  needs_clarification: 'More information needed',
};
const examples = [
  '帮我试算 ART-001 本月的结算',
  '查询 ART-001 2026 年 8 月已保存的结算报告',
  '商品標籤需要哪些資訊？',
];
function AnswerBubble({ answer }: { answer: AssistantAnswer }) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [pdfPreview, setPdfPreview] = useState<{
    url: string;
    label: string;
    download: () => Promise<void>;
  } | null>(null);
  const result = answer.result;
  const fallback = answer.resourceFallback;
  const resources = fallback?.resources ?? answer.resources;
  const citations = fallback?.citations ?? answer.citations;
  async function download() {
    if (result?.kind !== 'report') return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadReport(result.data.reportId);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Download failed.');
    } finally {
      setDownloading(false);
    }
  }
  return (
    <div className="chat-bubble chat-bubble--assistant">
      <span
        className={`badge ${answer.outcome === 'tool_error' ? 'badge--danger' : answer.outcome === 'answered' ? 'badge--success' : 'badge--neutral'}`}
      >
        {outcomeLabel[answer.outcome]}
      </span>
      <p className="chat-answer-text">{answer.answer}</p>
      {result && (
        <>
          <details className="chat-bubble__details">
            <summary>
              {result.kind === 'preview'
                ? 'Preview details · Not saved'
                : 'Saved report details · Draft'}
            </summary>
            <SettlementBreakdown
              result={
                result.kind === 'preview'
                  ? result.data.result
                  : { ...result.data, ...result.data.financialSummary }
              }
            />
          </details>
          {result.kind === 'report' && (
            <button
              type="button"
              className="button--secondary"
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading ? 'Downloading…' : 'Download saved PDF'}
            </button>
          )}
          <p>
            <Link to="/settlements">Open Settlement Runs</Link>
          </p>
          {downloadError && <p role="alert">{downloadError}</p>}
        </>
      )}
      {pdfPreview && (
        <Suspense fallback={<p role="status">正在准备 PDF 预览…</p>}>
          <PdfPreview
            url={pdfPreview.url}
            label={pdfPreview.label}
            onClose={() => setPdfPreview(null)}
            onDownload={pdfPreview.download}
          />
        </Suspense>
      )}
      {resources && resources.length > 0 && (
        <section aria-label={fallback ? '可查看的附件' : '相关资源'}>
          <h4>{fallback ? '可查看的附件' : '相关资源'}</h4>
          {fallback && <p>以下来源仅用于确认附件入口，不作为合同条款的回答依据。</p>}
          {resources.map((resource) => (
            <div key={resource.resourceId} className="chat-resource">
              <strong>{resource.label}</strong>
              {resource.availability === 'missing' && <p>资源暂不可用</p>}
              {!resource.contentIndexed && <p>此链接目标的正文未纳入问答资料。</p>}
              <div>
                {resource.actions.map((action) =>
                  action.kind === 'visit' ? (
                    <a
                      key={action.kind}
                      href={action.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {action.label}
                    </a>
                  ) : (
                    <button
                      key={action.kind}
                      type="button"
                      onClick={async () => {
                        setDownloadError(null);
                        if (action.kind === 'view' && resource.kind === 'pdf') {
                          const downloadUrl = resource.actions.find(
                            (item) => item.kind === 'download',
                          )?.url;
                          setPdfPreview({
                            url: `${BASE_URL.replace(/\/api\/v1$/, '')}${action.url}`,
                            label: resource.label,
                            download: async () => {
                              if (!downloadUrl) throw new Error('资源不可用。');
                              const response = await fetch(
                                `${BASE_URL.replace(/\/api\/v1$/, '')}${downloadUrl}`,
                              );
                              if (!response.ok) throw new Error('资源不可用。');
                              const url = URL.createObjectURL(await response.blob());
                              const link = document.createElement('a');
                              const filename = response.headers
                                .get('Content-Disposition')
                                ?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
                              link.href = url;
                              link.download = filename
                                ? decodeURIComponent(filename)
                                : resource.label;
                              link.click();
                              window.setTimeout(() => URL.revokeObjectURL(url), 60000);
                            },
                          });
                          return;
                        }
                        const popup = action.kind === 'view' ? window.open('', '_blank') : null;
                        if (popup) popup.opener = null;
                        try {
                          const response = await fetch(
                            `${BASE_URL.replace(/\/api\/v1$/, '')}${action.url}`,
                          );
                          if (!response.ok)
                            throw new Error('资源暂时不可用，请稍后重试或联系维护人员。');
                          const blob = await response.blob();
                          const url = URL.createObjectURL(blob);
                          if (action.kind === 'view' && popup) popup.location.href = url;
                          else {
                            const a = document.createElement('a');
                            a.href = url;
                            const filename = response.headers
                              .get('Content-Disposition')
                              ?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
                            a.download = filename ? decodeURIComponent(filename) : resource.label;
                            a.click();
                          }
                          window.setTimeout(() => URL.revokeObjectURL(url), 60000);
                        } catch (error) {
                          popup?.close();
                          setDownloadError(error instanceof Error ? error.message : '资源不可用。');
                        }
                      }}
                    >
                      {action.label}
                    </button>
                  ),
                )}
              </div>
            </div>
          ))}
          {downloadError && <p role="alert">{downloadError}</p>}
        </section>
      )}
      {citations.length > 0 && (
        <details className="chat-bubble__details" open>
          <summary>
            {fallback ? '附件入口来源' : 'Sources'} ({citations.length})
          </summary>
          <ol>
            {citations.map((citation) => (
              <li key={citation.chunkId}>
                <strong>{citation.title}</strong> · {citation.locator}
                <blockquote>{citation.excerpt}</blockquote>
                {citation.sourceUrl && (
                  <a href={citation.sourceUrl} target="_blank" rel="noopener noreferrer">
                    查看原文
                  </a>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
export function AssistantPage() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const busy = useRef(false);
  const active = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState('');
  const [progress, setProgress] = useState('');
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  function cancel(clear = false) {
    active.current?.abort();
    active.current = null;
    busy.current = false;
    setPending(false);
    setDraft('');
    setProgress('');
    setMessages((current) => (clear ? [] : current.slice(0, -1)));
    if (!clear) setError(new Error('已停止生成，本次未完成的回答不会加入对话。'));
  }
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void getAssistantStatus().then(setStatus).catch(setError);
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, pending, draft, progress]);
  async function send(message: string) {
    if (!message.trim() || busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    active.current = controller;
    setDraft('');
    setProgress('正在连接…');
    setPending(true);
    setError(null);
    const completedMessages = messages.filter((item, index) => {
      if (item.role === 'assistant') return item.answer.outcome !== 'tool_error';
      const next = messages[index + 1];
      return next?.role === 'assistant' && next.answer.outcome !== 'tool_error';
    });
    const history: NonNullable<AssistantRequest['history']> = completedMessages
      .slice(-12)
      .map((item) => ({
        role: item.role,
        content: (item.role === 'user' ? item.text : assistantHistoryContent(item.answer)).slice(
          0,
          4000,
        ),
      }));
    setMessages((current) => [...current, { role: 'user', text: message.trim() }]);
    setInput('');
    try {
      const answer = await streamAssistant(
        { message: message.trim(), history },
        (event) => {
          if (active.current !== controller) return;
          if (event.type === 'status') setProgress(event.message);
          if (event.type === 'text_delta') setDraft((current) => current + event.delta);
        },
        controller.signal,
      );
      if (active.current !== controller) return;
      setMessages((current) => [...current, { role: 'assistant', answer }]);
    } catch (caught) {
      if (active.current !== controller) return;
      setError(caught instanceof Error ? caught : new Error('Could not send the question.'));
      setInput(message);
      // Failed turns must not become context for the next retry.
      setMessages((current) => current.slice(0, -1));
    } finally {
      if (active.current === controller) {
        active.current = null;
        busy.current = false;
        setPending(false);
        setDraft('');
        setProgress('');
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }
  return (
    <div className="page-wrap">
      <header className="page-head">
        <p className="page-head__eyebrow">Settlement & operations assistant</p>
        <h1>Chatbot</h1>
        <p>用中文或英文提问：试算结算、查询已保存报告，或了解操作流程。试算不会保存报告。</p>
      </header>
      {status && !status.configured && (
        <div className="panel" role="status">
          <p>Chatbot 尚未就绪，请完成服务器模型配置并重启服务。当前不会返回模拟答案。</p>
          <button
            type="button"
            className="button--secondary"
            onClick={() => {
              setError(null);
              void getAssistantStatus().then(setStatus).catch(setError);
            }}
          >
            Check again
          </button>
        </div>
      )}
      <section className="panel">
        <div className="actions-row">
          <h2 className="panel__title">Conversation</h2>
          <button
            type="button"
            className="button--secondary"
            disabled={!pending && messages.length === 0}
            onClick={() => {
              if (active.current) cancel(true);
              else setMessages([]);
              setError(null);
              setInput('');
            }}
          >
            New conversation
          </button>
        </div>
        <div className="chat-thread" role="log" aria-label="Conversation" aria-live="polite">
          {messages.length === 0 && (
            <EmptyState label="输入问题，或点击下方示例开始。缺少艺术家或月份时，我会继续询问。" />
          )}
          {messages.map((message, index) =>
            message.role === 'user' ? (
              <div className="chat-bubble chat-bubble--user" key={index}>
                {message.text}
              </div>
            ) : (
              <AnswerBubble key={index} answer={message.answer} />
            ),
          )}
          {pending && (
            <div className="chat-bubble chat-bubble--assistant" aria-busy="true">
              <LoadingState label={progress} />
              {draft && (
                <>
                  <p className="hint">生成中，引用尚未校验</p>
                  <p className="chat-answer-text">{draft}</p>
                </>
              )}
            </div>
          )}
          <div ref={end} />
        </div>
        {error && (
          <ErrorState
            title={error.message}
            requestId={error instanceof ApiError ? error.requestId : undefined}
          />
        )}
        <div className="actions-row chat-examples">
          {examples.map((question) => (
            <button
              type="button"
              className="button--secondary"
              key={question}
              disabled={pending || status?.configured === false}
              onClick={() => void send(question)}
            >
              {question}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="chat-composer">
          <label htmlFor="chat-question">Your question / 你的问题</label>
          <textarea
            id="chat-question"
            maxLength={4000}
            rows={3}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={pending}
            placeholder="例如：帮我试算 ART-001 2026 年 9 月的结算"
          />
          <div className="actions-row">
            <button
              type="submit"
              disabled={pending || !input.trim() || status?.configured === false}
            >
              {pending ? 'Sending…' : 'Send'}
            </button>
            {pending && (
              <button type="button" className="button--secondary" onClick={() => cancel()}>
                停止生成
              </button>
            )}
            <span className="hint">每次处理一个需求 · 金额来自业务服务 · SOP 回答附来源</span>
          </div>
        </form>
      </section>
    </div>
  );
}
