type MaybePromiseWs<T = unknown> = T | Promise<T>;

const hasId = (v: unknown): v is { id: number } => {
    return v instanceof Object && 'id' in v && typeof v.id === 'number';
};

class WebsocketWrapper<Client, Server> {
    public open = false;

    private disconnectReason: string | undefined;
    public reconnect = false;
    private reconnectTries = 0;

    private pending = new Map<number, (message: Server) => MaybePromiseWs>();
    public ws: WebSocket | undefined;

    constructor(
        private websocketConstructor: () => WebSocket,
        private parseClient: (data: unknown) => Client,
        private parseServer: (data: unknown) => Server,
    ) {
        this.initWebsocket();
    }

    private initWebsocket() {
        if (this.ws) {
            this.ws.close();
        }

        this.open = false;

        const ws = (this.ws = this.websocketConstructor());

        ws.onopen = () => {
            // reconnected
            if (this.ws !== ws) return;

            this.open = true;
            this.disconnectReason = undefined;

            if (!this.reconnectTries) this.onConnect && this.onConnect();

            this.reconnectTries = 0;
        };

        ws.onerror = ev => {
            // reconnected
            if (this.ws !== ws) return;

            if (!this.open) {
                if (this.reconnectTries) {
                    if (this.reconnect && this.reconnectTries++ < 5) {
                        this.initWebsocket();
                        return;
                    } else {
                        this.onDisconnect &&
                        this.onDisconnect(this.disconnectReason ?? '');
                    }
                } else {
                    this.onFailure && this.onFailure(ev);
                }
            }
        };

        ws.onclose = ev => {
            // reconnected
            if (this.ws !== ws) return;

            if (this.reconnect && this.reconnectTries++ < 5) {
                this.disconnectReason = ev.reason;
                this.initWebsocket();
                return;
            }

            this.open = false;
            this.onDisconnect && this.onDisconnect(ev.reason ?? '');
        };

        ws.onmessage = ev => {
            // reconnected
            if (this.ws !== ws) return;

            if (typeof ev.data === 'string' && this.onMessage) {
                const data: Server = this.parseServer(JSON.parse(ev.data));

                if (hasId(data)) {
                    const resolve = this.pending.get(data.id);
                    if (resolve) {
                        this.pending.delete(data.id);
                        resolve(data);
                        return;
                    }
                }

                this.onMessage(data);
            }
        };
    }

    private onConnect: (() => MaybePromiseWs) | undefined = undefined;
    private onFailure: ((ev: Event) => MaybePromiseWs) | undefined = undefined;
    private onDisconnect: ((reason: string) => MaybePromiseWs) | undefined = undefined;
    private onMessage: ((message: Server) => MaybePromiseWs) | undefined = undefined;

    send(message: Client & { id?: number; }, resolve: true): Promise<Server>;
    send(message: Client): void;
    send(message: Client, resolve?: true) {
        if (!this.open || !this.ws) {
            if (resolve) {
                return Promise.reject();
            } else {
                return;
            }
        }

        let id: number | undefined;
        if (resolve) {
            id = Date.now();
            (message as Client & { id?: number; }).id = id;
        }

        const parsed = this.parseClient(message);
        const converted = JSON.stringify(parsed);

        this.ws.send(converted);

        if (!resolve) return;

        let resolver: (v: Server) => MaybePromiseWs;
        const promise = new Promise<Server>((r, e) => {
            resolver = r;
            setTimeout(() => {
                this.pending.delete(id!);
                e('Timeout!');
            }, 5000);
        });
        this.pending.set(id!, resolver!);
        return promise;
    }

    autoReconnect() {
        this.reconnect = true;
        return this;
    }

    connect(callback: () => MaybePromiseWs) {
        this.onConnect = callback;
        return this;
    }

    failure(callback: (ev: Event) => MaybePromiseWs) {
        this.onFailure = callback;
        return this;
    }

    disconnect(callback: (reason: string) => MaybePromiseWs) {
        this.onDisconnect = callback;
        return this;
    }

    message(callback: (message: Server) => MaybePromiseWs) {
        this.onMessage = callback;
        return this;
    }

    destroy() {
        this.ws?.close();
        // stops all event handlers
        this.open = false;
        this.ws = undefined;
    }
}

