<#
  SO Review agent: export the "RELEASE SO..." emails from Outlook desktop as JSON (read-only: nothing is changed in the mailbox).
  Searches the Inbox (and its subfolders) and Sent Items of the default mailbox for messages whose subject contains "RELEASE",
  received in the last -Days days. For each: subject, sender address, received time, the start of the body and a reference.
  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File outlook-release-mail.ps1 -Days 240 -Out C:\path\mail.json
#>
param([int]$Days = 240, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace('MAPI')
} catch {
  @{ ok = $false; error = 'Outlook is not available on this PC: ' + $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $Out -Encoding UTF8
  exit 0
}
$since = (Get-Date).AddDays(-$Days).ToString('MM/dd/yyyy HH:mm')
$filter = "@SQL=(""urn:schemas:httpmail:subject"" LIKE '%RELEASE%') AND (""urn:schemas:httpmail:datereceived"" >= '$since')"
$list = New-Object System.Collections.ArrayList
function Get-Sender($m) {
  try {
    if ($m.SenderEmailType -eq 'EX') { $u = $m.Sender.GetExchangeUser(); if ($u) { return $u.PrimarySmtpAddress } }
    return $m.SenderEmailAddress
  } catch { return $m.SenderEmailAddress }
}
function Read-Folder($f, $depth) {
  try { $items = $f.Items.Restrict($filter) } catch { return }
  foreach ($m in $items) {
    if ($m.Class -ne 43) { continue }   # mail items only
    $body = ''
    try { $body = [string]$m.Body; if ($body.Length -gt 4000) { $body = $body.Substring(0, 4000) } } catch {}
    [void]$list.Add([ordered]@{
      subject     = [string]$m.Subject
      senderEmail = [string](Get-Sender $m)
      senderName  = [string]$m.SenderName
      received    = $m.ReceivedTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      body        = $body
      ref         = 'outlook:' + [string]$m.EntryID
      folder      = [string]$f.Name
      hasAttachments = ($m.Attachments.Count -gt 0)
    })
  }
  if ($depth -lt 3) { foreach ($sub in $f.Folders) { Read-Folder $sub ($depth + 1) } }
}
try {
  Read-Folder ($ns.GetDefaultFolder(6)) 0   # Inbox and subfolders
  Read-Folder ($ns.GetDefaultFolder(5)) 3   # Sent Items
  @{ ok = $true; account = [string]$ns.CurrentUser.Name; count = $list.Count; mails = $list } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $Out -Encoding UTF8
} catch {
  @{ ok = $false; error = 'Reading Outlook failed: ' + $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $Out -Encoding UTF8
}
