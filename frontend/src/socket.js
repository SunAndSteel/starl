export function createSocketClient({ url, onMessage, onState }) {
  let socket = null;
  let retryDelay = 1000;
  let closed = false;
  let keepAlive = null;

  const connect = () => {
    if (closed) {
      return;
    }

    onState("connecting");
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      retryDelay = 1000;
      onState("open");
      keepAlive = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send("ping");
        }
      }, 15000);
    });

    socket.addEventListener("message", (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (error) {
        console.error("Invalid WebSocket payload", error);
      }
    });

    socket.addEventListener("error", () => {
      socket?.close();
    });

    socket.addEventListener("close", () => {
      window.clearInterval(keepAlive);
      keepAlive = null;
      if (closed) {
        return;
      }
      onState("reconnecting");
      window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.7, 10000);
    });
  };

  return {
    start() {
      connect();
    },
    stop() {
      closed = true;
      window.clearInterval(keepAlive);
      socket?.close();
    },
  };
}
