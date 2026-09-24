# 한글(한컴오피스) 자동화로 HWPX를 열어 용지·여백·쪽수를 확인한다.
# 사용: powershell -ExecutionPolicy Bypass -File scripts/verify-hwpx.ps1 -Path data/test.hwpx
param([Parameter(Mandatory = $true)][string]$Path)
$full = (Resolve-Path $Path).Path
$hwp = New-Object -ComObject HWPFrame.HwpObject
try {
  $null = $hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModuleExample")
  $hwp.XHwpWindows.Item(0).Visible = $false
  $fmt = if ($full -match ".hwpx$") { "HWPX" } else { "HWP" }
  $ok = $hwp.Open($full, $fmt, "forceopen:true;suspendpassword:true")
  if (-not $ok) { Write-Output "OPEN_FAILED"; exit 1 }
  $act = $hwp.CreateAction("PageSetup")
  $set = $act.CreateSet()
  $act.GetDefault($set)
  $pd = $set.Item("PageDef")
  $u = 7200 / 25.4
  $r = [ordered]@{
    open        = $true
    pageCount   = $hwp.PageCount
    paperWidth  = [math]::Round($pd.Item("PaperWidth") / $u, 2)
    paperHeight = [math]::Round($pd.Item("PaperHeight") / $u, 2)
    left        = [math]::Round($pd.Item("LeftMargin") / $u, 2)
    right       = [math]::Round($pd.Item("RightMargin") / $u, 2)
    top         = [math]::Round($pd.Item("TopMargin") / $u, 2)
    bottom      = [math]::Round($pd.Item("BottomMargin") / $u, 2)
    header      = [math]::Round($pd.Item("HeaderLen") / $u, 2)
    footer      = [math]::Round($pd.Item("FooterLen") / $u, 2)
    gutterType  = $pd.Item("GutterType")   # 0 한쪽, 1 맞쪽, 2 위로
    text        = ($hwp.GetTextFile("TEXT", "")).Substring(0, 200)
  }
  $r | ConvertTo-Json
}
finally {
  $hwp.Clear(1)
  $hwp.Quit()
}
