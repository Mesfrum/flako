import type { Connect } from "./liveNote";
import type { ServerMsg } from "./protocol";

/** The browser WebSocket behind LiveNote: same origin, JSON frames, `/api/notes/<id>/live`. */
export function webSocketConnect(): Connect {
  return (noteId, handlers) => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/api/notes/${noteId}/live`);
    ws.onopen = () => handlers.onOpen();
    ws.onmessage = (e: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return; // not ours; ignore
      }
      handlers.onMessage(msg);
    };
    ws.onclose = (e) => handlers.onClose(e.code);
    return {
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => ws.close(),
    };
  };
}
