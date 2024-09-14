class SSE<Message> {
    public open = false;
    public sse: EventSource;
    private messageHandler: ((ev: MessageEvent) => void) | null = null;
    private closeHandler: ((ev: Event) => void) | null = null;

    constructor(
        private init: () => EventSource,
        private parse: (data: unknown) => Message,
    ) {
        this.sse = init();
        this.sse.addEventListener('open', () => {
            this.open = true;
        });
        this.sse.addEventListener('error', (ev: unknown) => {
            this.open = false;
            this.closeHandler && this.closeHandler(ev as Event);
        });
        this.sse.addEventListener('message', (ev: unknown) => {
            this.messageHandler && this.messageHandler(ev as MessageEvent);
        });
    }

    onMessage(handler: (this: SSE<Message>, data: Message) => void) {
        this.messageHandler = (ev) => {
            handler.call(this, this.parse(JSON.parse(ev.data!)));
        }
    }

    onClose(handler: (this: SSE<Message>, reason: Event) => void) {
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

