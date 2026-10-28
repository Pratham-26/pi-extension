import { MAX_PI_SHELL_COMMAND_CHARS, validatePiShellCommand } from './shell-command';

export const MAX_QUEUED_PI_SHELL_COMMANDS_PER_SESSION = 100;

export type QueuedPiShellCommand = {
  id: string;
  command: string;
  excludeFromContext: boolean;
};

export class SessionShellCommandQueue {
  private readonly queues = new Map<string, QueuedPiShellCommand[]>();

  enqueue(sessionKey: string, item: QueuedPiShellCommand): boolean {
    if (!sessionKey || sessionKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionKey)) return false;
    if (!/^[a-f0-9]{32}$/.test(item.id) || item.command.length > MAX_PI_SHELL_COMMAND_CHARS
      || validatePiShellCommand(item.command)) return false;
    const queue = this.queues.get(sessionKey) ?? [];
    if (queue.length >= MAX_QUEUED_PI_SHELL_COMMANDS_PER_SESSION) return false;
    queue.push({ ...item });
    this.queues.set(sessionKey, queue);
    return true;
  }

  list(sessionKey: string): QueuedPiShellCommand[] {
    return (this.queues.get(sessionKey) ?? []).map((item) => ({ ...item }));
  }

  first(sessionKey: string): QueuedPiShellCommand | undefined {
    const item = this.queues.get(sessionKey)?.[0];
    return item ? { ...item } : undefined;
  }

  remove(sessionKey: string, id: string): boolean {
    const queue = this.queues.get(sessionKey);
    if (!queue) return false;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (!queue.length) this.queues.delete(sessionKey);
    return true;
  }

  clear(sessionKey: string): number {
    const queue = this.queues.get(sessionKey);
    this.queues.delete(sessionKey);
    return queue?.length ?? 0;
  }

  clearAll(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    this.queues.clear();
    return total;
  }
}
