import { RequestTimeoutException } from '@nestjs/common';

export interface InspectorLogCapture { close(): void; }
interface InspectorTarget { webSocketDebuggerUrl?: string; }
interface InspectorMessage { id?: number; method?: string; params?: { name?: string; payload?: string }; result?: { result?: { value?: unknown } }; error?: { message?: string }; }

const inspectorUrl = 'http://127.0.0.1:9229/json/list';
const bindingName = '__dockyardCapture';
const bridgeKey = 'dockyard.inspector.capture.v1';

/** Captures writes from an opt-in Node process through its localhost-only Inspector endpoint. */
export async function startInspectorLogCapture(pid: number, onLog: (stream: 'stdout' | 'stderr', data: Buffer) => void, onClosed: () => void): Promise<InspectorLogCapture> {
  process.kill(pid, 'SIGUSR1');
  const targets = await fetch(inspectorUrl, { signal: AbortSignal.timeout(2_000) }).then(async (response) => {
    if (!response.ok) throw new RequestTimeoutException('Node Inspector 未返回可用目标。');
    return response.json() as Promise<InspectorTarget[]>;
  }).catch((error: unknown) => { throw error instanceof RequestTimeoutException ? error : new RequestTimeoutException('无法连接 Node Inspector。'); });
  const endpoint = targets.find((target) => typeof target.webSocketDebuggerUrl === 'string')?.webSocketDebuggerUrl;
  if (!endpoint) throw new RequestTimeoutException('Node Inspector 未返回 WebSocket 端点。');
  const socket = new WebSocket(endpoint);
  const replies = new Map<number, (message: InspectorMessage) => void>();
  let sequence = 0;
  const close = () => { try { socket.close(); } catch {} };
  socket.addEventListener('message', (event) => {
    let message: InspectorMessage;
    try { message = JSON.parse(String(event.data)) as InspectorMessage; } catch { return; }
    if (message.method === 'Runtime.bindingCalled' && message.params?.name === bindingName && typeof message.params.payload === 'string') {
      try {
        const payload = JSON.parse(message.params.payload) as { stream?: unknown; data?: unknown };
        if ((payload.stream === 'stdout' || payload.stream === 'stderr') && typeof payload.data === 'string') onLog(payload.stream, Buffer.from(payload.data, 'utf8'));
      } catch { /* Ignore malformed data emitted by an untrusted inspected process. */ }
    }
    if (message.id !== undefined) { const resolve = replies.get(message.id); if (resolve) { replies.delete(message.id); resolve(message); } }
  });
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new RequestTimeoutException('无法打开 Node Inspector WebSocket。')), { once: true }); });
  const command = async (method: string, params: Record<string, unknown> = {}): Promise<InspectorMessage> => {
    const id = ++sequence;
    const reply = await new Promise<InspectorMessage>((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new RequestTimeoutException(`Node Inspector ${method} 超时。`)); }, 2_000);
      timer.unref();
      replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
      socket.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new RequestTimeoutException(`Node Inspector ${method} 失败：${reply.error.message ?? '未知错误'}`);
    return reply;
  };
  try {
    await command('Runtime.enable');
    const identity = await command('Runtime.evaluate', { expression: 'process.pid', returnByValue: true });
    if (identity.result?.result?.value !== pid) throw new RequestTimeoutException('Inspector 端点不属于目标进程，已拒绝连接。');
    await command('Runtime.addBinding', { name: bindingName });
    await command('Runtime.evaluate', { expression: `(() => { const key = Symbol.for('${bridgeKey}'); if (globalThis[key]) return 'already-installed'; const emit = (stream, chunk) => { try { globalThis.${bindingName}(JSON.stringify({ stream, data: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk) })); } catch {} }; for (const [stream, target] of Object.entries({ stdout: process.stdout, stderr: process.stderr })) { const write = target.write; target.write = function(chunk, ...args) { const written = write.call(this, chunk, ...args); emit(stream, chunk); return written; }; } globalThis[key] = true; return 'installed'; })()`, returnByValue: true });
  } catch (error) { close(); throw error; }
  socket.addEventListener('close', onClosed, { once: true });
  socket.addEventListener('error', onClosed, { once: true });
  return { close };
}
