/**
 * Drop the first stack-trace frame containing `/sandstone-cli/src/` and
 * every frame below it (deeper in the call). The user-code frames above
 * the CLI boundary stay readable — useful for debugging user errors that
 * surfaced via the `sand watch` flow.
 *
 * Splits on `\n`, finds the first line with `/sandstone-cli/src/`, keeps
 * everything before it. If no CLI frame is found, returns the input
 * unchanged.
 */
export const stripCliFrames = (s: string): string => {
  const lines = s.split('\n')
  const idx = lines.findIndex((line) => line.includes('/sandstone-cli/src/'))
  return idx === -1 ? s : lines.slice(0, idx).join('\n')
}