import { ReportError } from '../../shared/report-errors.js';
export type RagErrorCode =
  | 'RAG_CONFIG_INVALID'
  | 'RAG_INDEX_UNAVAILABLE'
  | 'RAG_PROVIDER_UNAVAILABLE'
  | 'RAG_PROVIDER_TIMEOUT'
  | 'RAG_EVIDENCE_INVALID'
  | 'RAG_CAPACITY_EXCEEDED';
const definitions: Record<RagErrorCode, [number, string]> = {
  RAG_CONFIG_INVALID: [503, '知识检索配置未就绪，请联系维护人员检查配置。'],
  RAG_INDEX_UNAVAILABLE: [503, '知识索引未就绪或版本不匹配，请重建索引后重试。'],
  RAG_PROVIDER_UNAVAILABLE: [503, '知识检索服务暂时不可用，请稍后重试。'],
  RAG_PROVIDER_TIMEOUT: [504, '知识检索服务响应超时，请重试。'],
  RAG_EVIDENCE_INVALID: [502, '知识资料校验失败，请联系维护人员检查来源。'],
  RAG_CAPACITY_EXCEEDED: [503, '知识库超过当前检索容量，请联系维护人员。'],
};
export class RagError extends ReportError {
  constructor(code: RagErrorCode) {
    const [status, message] = definitions[code];
    super(status, code, message);
  }
}
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
