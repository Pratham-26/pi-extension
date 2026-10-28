export const MAX_PI_SHELL_COMMAND_CHARS = 16_000;

export type ParsedPiShellCommand = {
  command: string;
  excludeFromContext: boolean;
};

export function parsePiShellCommandInput(text: string): ParsedPiShellCommand | undefined {
  const input = text.trimStart();
  if (!input.startsWith('!')) return undefined;
  const excludeFromContext = input.startsWith('!!');
  return {
    command: input.slice(excludeFromContext ? 2 : 1).trim(),
    excludeFromContext,
  };
}

export function validatePiShellCommand(command: string): string | undefined {
  if (!command.trim()) return 'Enter a command after !.';
  if (command.length > MAX_PI_SHELL_COMMAND_CHARS) {
    return `Shell commands are limited to ${MAX_PI_SHELL_COMMAND_CHARS.toLocaleString()} characters.`;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
    return 'The shell command contains unsupported control characters.';
  }
  return undefined;
}
