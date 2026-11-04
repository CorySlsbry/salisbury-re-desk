/** Turn raw errors (Rust, Python sidecar, fetch, SQLite) into one plain sentence Cory can act on. */
export function friendlyError(e: unknown): string {
  const raw = String((e as { message?: string })?.message ?? e ?? '').trim();
  const s = raw.replace(/^Error:\s*/i, '');
  const rules: Array<[RegExp, string]> = [
    [/PermissionError|Permission denied|being used by another process|os error 32|code=2: cannot remove file/i, 'That PDF is open in another program (Acrobat, Chrome, Explorer preview). Close it and try again.'],
    [/no such file|cannot find the (file|path)|os error 2|FileNotFound/i, 'A file or folder is missing on disk. Check that the client folder and the form still exist, then try again.'],
    [/Invalid argument|os error 22/i, 'The file name or path was not valid. Try again; if it repeats, rename the client folder so it has no unusual characters.'],
    [/database is locked|SQLITE_BUSY/i, 'The database is busy (usually Google Drive syncing it). Wait a moment and try again.'],
    [/UNIQUE constraint/i, 'That record already exists. Nothing was duplicated.'],
    [/llama|model is not running|ECONNREFUSED 127\.0\.0\.1:8093|did not answer within/i, 'The local AI is not answering. Give it a minute after launch, or check Settings > Local AI.'],
    [/sidecar not found|doc engine|redesk-doc|EPIPE/i, 'The document engine did not respond. Restart the app; if it repeats, check Norton quarantine for redesk-doc.exe.'],
    [/Google (401|403)|invalid_grant|Token refresh failed/i, 'Google no longer accepts the saved login. Go to Settings and connect Google again.'],
    [/Google 404|Google 410/i, 'That calendar event no longer exists in Google (it was deleted there). Push again to recreate it.'],
    [/Failed to fetch|NetworkError|ENOTFOUND|getaddrinfo/i, 'No internet connection right now. Everything local still works; try the online step again later.'],
    [/timed out waiting for Google/i, 'Google did not send the app an approval within 5 minutes. Click Connect again and approve in the browser tab.'],
    [/OAuth state mismatch/i, 'The Google approval did not match this attempt. Click Connect once more.'],
    [/not a pdf|cannot open broken document|is not a PDF/i, 'That file is not a readable PDF. Export it again from the source and retry.'],
  ];
  for (const [rx, msg] of rules) if (rx.test(s)) return msg;
  if (!s) return 'Something went wrong, but no details were reported. Try again; if it repeats, tell Cory the step you were on.';
  return s.length > 220 ? `${s.slice(0, 200)}… (details in Backups\\boot.log)` : s;
}
