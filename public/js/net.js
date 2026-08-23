// =============================================================
// TIDEWRECK ISLAND - public/js/net.js
// Thin, defensive wrapper around the Socket.io client.
//
//   const net = createNet();
//   net.on(MSG.WORLD_STATE, ws => { ... });   // many listeners per type
//   net.send(MSG.MOVE, { p: [...] });
//   net.id();                                  // socket id or null
//
// Every server message is fanned out by its raw event name (see MSG in
// shared/constants.js). The socket lifecycle events 'connect', 'disconnect'
// and 'connect_error' are exposed through the same on() channel.
// =============================================================

const LIFECYCLE = { CONNECT: 'connect', DISCONNECT: 'disconnect', ERROR: 'connect_error' };

export function createNet() {
  // type -> listener array. Arrays are copy-on-write so dispatch never
  // allocates and mutating listeners mid-dispatch is safe.
  const listeners = new Map();

  let socket = null;
  let connected = false;
  let everConnected = false;
  let droppedSends = 0;

  function dispatch(type, data) {
    const arr = listeners.get(type);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](data);
      } catch (err) {
        console.error('[net] listener for "' + type + '" threw:', err);
      }
    }
  }

  // ---- socket construction -------------------------------------------------
  const io = globalThis.io;
  if (typeof io === 'function') {
    try {
      socket = io({
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 600,
        reconnectionDelayMax: 5000,
        timeout: 15000,
      });
    } catch (err) {
      console.error('[net] could not open a socket:', err);
      socket = null;
    }
  } else {
    console.error('[net] socket.io client not found (/socket.io/socket.io.js did not load). Running offline: the world renders, multiplayer is disabled.');
  }

  if (socket) {
    socket.on(LIFECYCLE.CONNECT, () => {
      connected = true;
      const rejoin = everConnected;
      everConnected = true;
      console.info('[net] connected as ' + socket.id + (rejoin ? ' (reconnected)' : ''));
      dispatch(LIFECYCLE.CONNECT, { id: socket.id, reconnected: rejoin });
    });

    socket.on(LIFECYCLE.DISCONNECT, (reason) => {
      connected = false;
      console.warn('[net] disconnected:', reason);
      dispatch(LIFECYCLE.DISCONNECT, { reason: String(reason || 'unknown') });
    });

    socket.on(LIFECYCLE.ERROR, (err) => {
      connected = false;
      dispatch(LIFECYCLE.ERROR, { message: (err && err.message) ? err.message : String(err) });
    });

    // Fan every other server event out to whoever registered for that name.
    socket.onAny((type, data) => {
      if (type === LIFECYCLE.CONNECT || type === LIFECYCLE.DISCONNECT || type === LIFECYCLE.ERROR) return;
      dispatch(type, data);
    });
  }

  // ---- public handle -------------------------------------------------------

  /** Send a message to the server. Returns false if it could not be sent. */
  function send(type, data) {
    if (!type) return false;
    if (!socket || !connected) {
      droppedSends++;
      if (droppedSends === 1 || droppedSends % 250 === 0) {
        console.warn('[net] dropped "' + type + '" - not connected (' + droppedSends + ' dropped so far)');
      }
      return false;
    }
    try {
      socket.emit(type, data === undefined ? {} : data);
      return true;
    } catch (err) {
      console.error('[net] failed to send "' + type + '":', err);
      return false;
    }
  }

  /** Subscribe to a message type. Any number of listeners per type. */
  function on(type, cb) {
    if (!type || typeof cb !== 'function') return cb;
    const arr = listeners.get(type);
    listeners.set(type, arr ? arr.concat(cb) : [cb]);
    // Late subscribers to 'connect' still learn we are already online.
    if (type === LIFECYCLE.CONNECT && connected && socket) {
      const id = socket.id;
      queueMicrotask(() => {
        try { cb({ id, reconnected: false }); } catch (err) { console.error('[net] connect listener threw:', err); }
      });
    }
    return cb;
  }

  /** Remove a previously registered listener. */
  function off(type, cb) {
    const arr = listeners.get(type);
    if (!arr) return;
    const next = arr.filter((fn) => fn !== cb);
    if (next.length) listeners.set(type, next);
    else listeners.delete(type);
  }

  /** Our socket id, or null before the first connection. */
  function id() {
    return (socket && socket.id) ? socket.id : null;
  }

  /** True while the socket is live. */
  function isConnected() {
    return connected;
  }

  return { send, on, off, id, isConnected, socket };
}
