// Ask the human for a secret value without the AI seeing it.
//
//  - In a real terminal: a prompt with hidden typing.
//  - Without a terminal (the AI started us) on Windows: a small password
//    window that appears on the user's screen.

import { spawn } from 'node:child_process';

export class PromptCancelled extends Error {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'PromptCancelled';
  }
}

export function canPromptInTerminal() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export function canPromptInWindow() {
  // BLIND_ENV_NO_WINDOW=1 can only take a permission away (nothing gets
  // approved without a window), so it is safe for tests and headless use.
  return process.platform === 'win32' && process.env.BLIND_ENV_NO_WINDOW !== '1';
}

export function promptTerminal(label) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    let value = '';
    stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const finish = (fn, arg) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stderr.write('\n');
      fn(arg);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(resolve, value);
        if (ch === '\u0003' || ch === '\u001b') return finish(reject, new PromptCancelled());
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const WINDOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$name    = $env:BLIND_ENV_PROMPT_NAME
$details = $env:BLIND_ENV_PROMPT_DETAILS
$timeout = [int]$env:BLIND_ENV_PROMPT_TIMEOUT

$form = New-Object System.Windows.Forms.Form
$form.Text = 'blind-env'
$form.ClientSize = New-Object System.Drawing.Size(440, 214)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Location = New-Object System.Drawing.Point(16, 14)
$title.Size = New-Object System.Drawing.Size(408, 22)
$title.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$title.Text = "Enter the secret value for $name"
$title.AutoEllipsis = $true

$info = New-Object System.Windows.Forms.Label
$info.Location = New-Object System.Drawing.Point(16, 40)
$info.Size = New-Object System.Drawing.Size(408, 54)
$info.Text = $details

$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(16, 100)
$box.Size = New-Object System.Drawing.Size(408, 24)
$box.UseSystemPasswordChar = $true

$note = New-Object System.Windows.Forms.Label
$note.Location = New-Object System.Drawing.Point(16, 132)
$note.Size = New-Object System.Drawing.Size(408, 20)
$note.ForeColor = [System.Drawing.SystemColors]::GrayText
$note.Text = 'It is encrypted on this computer. The AI never sees what you type here.'

$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Save'
$ok.Location = New-Object System.Drawing.Point(254, 170)
$ok.Size = New-Object System.Drawing.Size(80, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(344, 170)
$cancel.Size = New-Object System.Drawing.Size(80, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$form.Controls.AddRange(@($title, $info, $box, $note, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel

$script:timedOut = $false
$timer = New-Object System.Windows.Forms.Timer
if ($timeout -gt 0) {
  $timer.Interval = $timeout * 1000
  $timer.Add_Tick({ $script:timedOut = $true; $timer.Stop(); $form.Close() })
  $timer.Start()
}
$form.Add_Shown({ $form.Activate(); $box.Focus() })

$result = $form.ShowDialog()
if ($script:timedOut) {
  [Console]::Out.Write('TIMEOUT')
} elseif ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write('OK:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($box.Text)))
} else {
  [Console]::Out.Write('CANCEL')
}
`;

/** Opens a password window on the user's screen (Windows). */
export function promptWindow(name, details = '', timeoutSeconds = 300) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(WINDOW_SCRIPT, 'utf16le').toString('base64')],
      {
        env: {
          ...process.env,
          BLIND_ENV_PROMPT_NAME: name,
          BLIND_ENV_PROMPT_DETAILS: details,
          BLIND_ENV_PROMPT_TIMEOUT: String(timeoutSeconds),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', (e) => reject(new Error(`cannot open the password window: ${e.message}`)));
    child.on('close', () => {
      out = out.trim();
      if (out.startsWith('OK:')) resolve(Buffer.from(out.slice(3), 'base64').toString('utf8'));
      else if (out === 'TIMEOUT') reject(new PromptCancelled('nobody answered the password window in time'));
      else if (out === 'CANCEL') reject(new PromptCancelled());
      else reject(new Error('the password window failed to open'));
    });
  });
}

const CONFIRM_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$titleText = $env:BLIND_ENV_CONFIRM_TITLE
$details   = $env:BLIND_ENV_CONFIRM_DETAILS
$okText    = $env:BLIND_ENV_CONFIRM_OK
$timeout   = [int]$env:BLIND_ENV_PROMPT_TIMEOUT

$form = New-Object System.Windows.Forms.Form
$form.Text = 'blind-env'
$form.ClientSize = New-Object System.Drawing.Size(460, 200)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Location = New-Object System.Drawing.Point(16, 14)
$title.Size = New-Object System.Drawing.Size(428, 44)
$title.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$title.Text = $titleText

$info = New-Object System.Windows.Forms.Label
$info.Location = New-Object System.Drawing.Point(16, 62)
$info.Size = New-Object System.Drawing.Size(428, 86)
$info.Text = $details

$ok = New-Object System.Windows.Forms.Button
$ok.Text = $okText
$ok.Location = New-Object System.Drawing.Point(254, 158)
$ok.Size = New-Object System.Drawing.Size(90, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(354, 158)
$cancel.Size = New-Object System.Drawing.Size(90, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

$form.Controls.AddRange(@($title, $info, $ok, $cancel))
# Enter and Escape both mean Cancel: approving takes a deliberate click.
$form.AcceptButton = $cancel
$form.CancelButton = $cancel

$script:timedOut = $false
$timer = New-Object System.Windows.Forms.Timer
if ($timeout -gt 0) {
  $timer.Interval = $timeout * 1000
  $timer.Add_Tick({ $script:timedOut = $true; $timer.Stop(); $form.Close() })
  $timer.Start()
}
$form.Add_Shown({ $form.Activate(); $cancel.Focus() })

$result = $form.ShowDialog()
if ($script:timedOut) { [Console]::Out.Write('TIMEOUT') }
elseif ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write('YES') }
else { [Console]::Out.Write('CANCEL') }
`;

/** A yes/no window (Windows). Resolves true only if the user clicked the OK button. */
export function confirmWindow({ title, details, okText = 'Allow', timeoutSeconds = 120 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(CONFIRM_SCRIPT, 'utf16le').toString('base64')],
      {
        env: {
          ...process.env,
          BLIND_ENV_CONFIRM_TITLE: title,
          BLIND_ENV_CONFIRM_DETAILS: details,
          BLIND_ENV_CONFIRM_OK: okText,
          BLIND_ENV_PROMPT_TIMEOUT: String(timeoutSeconds),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', (e) => reject(new Error(`cannot open the confirmation window: ${e.message}`)));
    child.on('close', () => {
      out = out.trim();
      if (out === 'YES') resolve(true);
      else if (out === 'CANCEL' || out === 'TIMEOUT') resolve(false);
      else reject(new Error('the confirmation window failed to open'));
    });
  });
}

function confirmTerminal(question) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(`${question} [y/N] `);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.once('data', (answer) => {
      stdin.pause();
      resolve(/^\s*y(es)?\s*$/i.test(answer));
    });
  });
}

/**
 * Ask the user to approve sending a key to new hosts. Resolves true or false.
 * On Windows this is always a window, even from a terminal, so a program that
 * types into a terminal cannot answer it.
 */
export async function confirmNewHosts(name, hosts, { description } = {}) {
  const title = `Allow ${name} to be sent to ${hosts.length === 1 ? hosts[0] : `${hosts.length} new sites`}?`;
  const details = [
    description ? `${name}: ${description}` : null,
    `New: ${hosts.join(', ')}`,
    'Only allow sites you trust with this secret. If you did not ask for this, click Cancel.',
  ]
    .filter(Boolean)
    .join('\n');
  if (canPromptInWindow()) return confirmWindow({ title, details });
  if (canPromptInTerminal()) return confirmTerminal(`${title}\n${details}\n`);
  throw new PromptCancelled('there is no window or terminal to ask the user in');
}

export function describeKeyForPrompt({ description, allow, replacing }) {
  const lines = [];
  if (description) lines.push(description);
  lines.push(allow?.length ? `Can be sent to: ${allow.join(', ')}` : 'Not allowed in web requests (no hosts set).');
  if (replacing) lines.push('This replaces the value saved before.');
  return lines.join('\n');
}
