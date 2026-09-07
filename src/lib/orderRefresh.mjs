// Serialize refreshes. Events received during a request require one trailing
// read, because the running response may predate the event's committed data.
export function createOrderRefresh() {
  let running = null;
  let pending = null;
  return function refresh(task) {
    pending = task;
    if (!running) {
      running = Promise.resolve().then(async () => {
        try {
          while (pending) {
            const next = pending;
            pending = null;
            await next();
          }
        } finally {
          running = null;
          pending = null;
        }
      });
    }
    return running;
  };
}
