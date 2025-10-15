class EventSauceEvent {
    readonly type: string;

    constructor(type: string) {
        this.type = type;
    }
}

class EventSauceMessage extends EventSauceEvent {
    readonly data: string;
    readonly lastEventId: string;
    readonly origin: string | null;
    // readonly ports: ReadonlyArray<MessagePort>;
    // readonly source: MessageEventSource | null;

    constructor(type: string, {data, lastEventId, origin}: {
        data: string,
        lastEventId: string,
        origin: string | null
    }) {
        super(type);
        this.data = data;
        this.lastEventId = lastEventId;
        this.origin = origin;
    }
}


class EventSauceError extends EventSauceEvent {
    public readonly response: Response | null;
    public readonly source: Error | null;

    constructor(response: Response | null, source: Error | null) {
        super('error');
        this.response = response;
        this.source = source;
    }
}

const comment = Symbol('comment');
const fields = ['data', 'event', 'id', 'retry'] as const;

class EventSauce {
    onerror: ((this: EventSauce, ev: EventSauceError) => any) | null;
    onmessage: ((this: EventSauce, ev: EventSauceMessage) => any) | null;
    onopen: ((this: EventSauce, ev: EventSauceEvent) => any) | null;

    readyState: number;
    url: string;
    reconnectAfter: number;
    lastEventId: string;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    constructor(from: Request) {
        this.onerror = null;
        this.onmessage = null;
        this.onopen = null;
        this.readyState = this.CONNECTING;
        this.url = from.url;
        this.reconnectAfter = 0;
        this.lastEventId = '';

        const headers = from.headers;
        headers.set('Accept', 'text/event-stream');

        const request = new Request(from, {
            method: 'GET',
            body: null,
            headers,
        });

        options.fetch(request)
            .then(async (res) => {
                if (res.body === null || res.status < 200 || res.status >= 300) {
                    this.readyState = this.CLOSED;
                    try {
                        this.onerror?.call(this, new EventSauceError(res, null));
                    } catch (e) {
                        console.error(e);
                    }
                    return;
                }

                this.readyState = this.OPEN;
                try {
                    this.onopen?.call(this, new EventSauceEvent('open'));
                } catch (e) {
                    console.error(e);
                }

                const textStream = res.body;
                const reader = textStream.getReader();

                try {
                    let buffer = '';
                    for (; ;) {
                        const {done, value} = await reader.read();
                        if (done) break;
                        const chunk = new TextDecoder().decode(value);
                        buffer += chunk;

                        const index = buffer.indexOf('\n\n');
                        if (index !== -1) {
                            const packet = buffer.slice(0, index);
                            buffer = buffer.slice(index + 2);

                            const result: Partial<Record<typeof comment | typeof fields[number], string>> = {};
                            for (const line of packet.split('\n')) {
                                const index = line.indexOf(': ');
                                if (index === -1) {
                                    return Promise.reject('Invalid packet received: no colon');
                                }

                                const label = (line.slice(0, index) || comment) as typeof comment | typeof fields[number];
                                const data = line.slice(index + 2);

                                // todo!() this is a script parsed, it could be made to just ignore these lines
                                if (label !== comment && !(fields.includes(label))) {
                                    return Promise.reject('Invalid packet received: invalid label');
                                }

                                if (label in result) {
                                    if (label !== 'data') {
                                        return Promise.reject(`Invalid packet received: double ${typeof label === 'string' ? label : 'comment'}`);
                                    }
                                    result[label] += '\n' + data;
                                } else {
                                    result[label] = data;
                                }
                            }

                            if (!(comment in result) && !('data' in result)) {
                                return Promise.reject(`Invalid packet received: neither data nor comment`);
                            }

                            if (comment in result && 'data' in result) {
                                return Promise.reject(`Invalid packet received: comment and data`);
                            }

                            if (comment in result) continue;

                            if (result.retry) {
                                const n = +result.retry;
                                if (Number.isSafeInteger(n)) {
                                    this.reconnectAfter = n;
                                }
                            }

                            if (result.id) {
                                this.lastEventId = result.id;
                            }

                            const ev = new EventSauceMessage(result.event || 'message', {
                                data: result.data!,
                                lastEventId: result.id || '',
                                origin: null
                            });

                            try {
                                this.onmessage?.call(this, ev);
                            } catch (e) {
                                console.error(e);
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            })
            .catch((rejection) => {
                let error =
                    rejection instanceof Error ? rejection : new Error(`${rejection}`);
                this.readyState = this.CLOSED;
                try {
                    this.onerror?.call(this, new EventSauceError(null, error));
                } catch (e) {
                    console.error(e);
                }
            });
    }
}

class SSE<Message> {
    public open = false;
    public sse: EventSauce;
    private messageHandler: ((ev: EventSauceMessage) => void) | null = null;
    private closeHandler: ((ev: EventSauceError) => void) | null = null;

    constructor(
        private init: () => EventSauce,
        private parse: (data: unknown) => Message,
    ) {
        this.sse = init();
        this.sse.onopen = () => {
            this.open = true;
        }
        this.sse.onerror = (ev) => {
            this.open = false;
            this.closeHandler && this.closeHandler(ev);
        }
        this.sse.onmessage = (ev) => {
            if (ev.type !== 'message') return;
            this.messageHandler && this.messageHandler(ev);
        }
    }

    onMessage(handler: (this: SSE<Message>, data: Message) => void) {
        this.messageHandler = (ev) => {
            handler.call(this, this.parse(JSON.parse(ev.data!)));
        }
    }

    onClose(handler: (this: SSE<Message>, reason: EventSauceError) => void) {
        this.closeHandler = (ev) => {
            handler.call(this, ev);
        }
    }

    reconnect() {
        if (!this.open) {
            this.sse = this.init();
        }
    }
}

