export interface Logger {
    info(message: string): void;
    warn(message: string, error?: unknown): void;
    error(message: string, error?: unknown): void;
}

export const LOG_PREFIX = "siliconflow-image-gen-mcp";

export function createLogger(prefix = LOG_PREFIX): Logger {
    const write = (level: string, message: string, error?: unknown): void => {
        const suffix = error === undefined ? "" : ` ${formatError(error)}`;
        process.stderr.write(`[${prefix}] ${level} ${message}${suffix}\n`);
    };

    return {
        info: (message) => write("info", message),
        warn: (message, error) => write("warn", message, error),
        error: (message, error) => write("error", message, error)
    };
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }
    return String(error);
}
