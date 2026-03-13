export class ExecutionLineSplitter {
    onLine;
    buffer = '';
    constructor(onLine) {
        this.onLine = onLine;
    }
    push(text) {
        if (!text) {
            return;
        }
        this.buffer += text;
        while (true) {
            const newlineIndex = this.buffer.indexOf('\n');
            if (newlineIndex === -1) {
                return;
            }
            const line = this.buffer.slice(0, newlineIndex + 1);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            this.onLine(line, true);
        }
    }
    flush() {
        if (!this.buffer) {
            return;
        }
        this.onLine(this.buffer, false);
        this.buffer = '';
    }
}
export function createExecutionEventFactory(command, requestId, path) {
    let sequence = 0;
    return (event) => ({
        command,
        request_id: requestId,
        path,
        timestamp: new Date().toISOString(),
        sequence: sequence++,
        ...event,
    });
}
