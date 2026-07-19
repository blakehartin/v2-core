param(
    [string]$Solc = "C:\solc\solc.exe",
    [string]$Abigen = "C:\gethbuild\abigen2.exe"
)

$ErrorActionPreference = "Stop"

$core = (Resolve-Path "$PSScriptRoot\..").Path
$quantumswap = (Resolve-Path "$core\..").Path
$github = (Resolve-Path "$quantumswap\..").Path
$periphery = Join-Path $quantumswap "v2-periphery"
$deploy = Join-Path $quantumswap "quantumswap-deploy"
$wq = Join-Path $github "wq"
$lib = Join-Path $github "solidity-lib"

foreach ($path in @($Solc, $Abigen, $periphery, $deploy, $wq, $lib)) {
    if (-not (Test-Path $path)) {
        throw "Required path does not exist: $path"
    }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Native command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

$compilerVersion = (& $Solc --version | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Unable to read compiler version from $Solc"
}
$common = @("--optimize", "--optimize-runs", "999999", "--metadata-hash", "none", "--overwrite")

$wqOut = Join-Path $deploy "contracts\wq"
$coreOut = Join-Path $deploy "contracts\corev2"
$routerOut = Join-Path $deploy "contracts\v2swaprouter"
$pairOut = Join-Path $deploy "contracts\pairv2"

Invoke-Native $Solc ($common + @("--bin", "--bin-runtime", "--abi", (Join-Path $wq "wrappedq.sol"), "-o", $wqOut))
Invoke-Native $Solc ($common + @("--bin", "--bin-runtime", "--abi", (Join-Path $core "contracts\UniswapV2Factory.sol"), "-o", $coreOut))
Invoke-Native $Solc ($common + @(
    "--bin", "--bin-runtime", "--abi",
    (Join-Path $periphery "contracts\UniswapV2Router02.sol"),
    "-o", $routerOut,
    "@uniswap/v2-core=$core",
    "@uniswap/lib=$lib"
))

Invoke-Native $Abigen @("--bin", (Join-Path $wqOut "WQ.bin"), "--abi", (Join-Path $wqOut "WQ.abi"), "--pkg", "wq", "--out", (Join-Path $wqOut "wq.go"))
Invoke-Native $Abigen @("--bin", (Join-Path $coreOut "UniswapV2Factory.bin"), "--abi", (Join-Path $coreOut "UniswapV2Factory.abi"), "--pkg", "corev2", "--out", (Join-Path $coreOut "UniswapV2Factory.go"))
Invoke-Native $Abigen @("--bin", (Join-Path $routerOut "UniswapV2Router02.bin"), "--abi", (Join-Path $routerOut "UniswapV2Router02.abi"), "--pkg", "v2swaprouter", "--out", (Join-Path $routerOut "UniswapV2Router02.go"))
Invoke-Native $Abigen @("--bin", (Join-Path $coreOut "UniswapV2Pair.bin"), "--abi", (Join-Path $coreOut "UniswapV2Pair.abi"), "--pkg", "pairv2", "--out", (Join-Path $pairOut "UniswapV2Pair.go"))

$repositories = [ordered]@{
    wq = $wq
    solidityLib = $lib
    v2Core = $core
    v2Periphery = $periphery
}

$sourcePins = [ordered]@{}
foreach ($entry in $repositories.GetEnumerator()) {
    $status = @(git -C $entry.Value status --porcelain --untracked-files=no)
    $sourcePins[$entry.Key] = [ordered]@{
        commit = (git -C $entry.Value rev-parse HEAD).Trim()
        trackedFilesClean = ($status.Count -eq 0)
    }
}

$artifactPaths = @(
    (Join-Path $wqOut "WQ.bin"),
    (Join-Path $wqOut "WQ.bin-runtime"),
    (Join-Path $wqOut "WQ.abi"),
    (Join-Path $coreOut "UniswapV2Factory.bin"),
    (Join-Path $coreOut "UniswapV2Factory.bin-runtime"),
    (Join-Path $coreOut "UniswapV2Factory.abi"),
    (Join-Path $coreOut "UniswapV2Pair.bin"),
    (Join-Path $coreOut "UniswapV2Pair.bin-runtime"),
    (Join-Path $coreOut "UniswapV2Pair.abi"),
    (Join-Path $routerOut "UniswapV2Router02.bin"),
    (Join-Path $routerOut "UniswapV2Router02.bin-runtime"),
    (Join-Path $routerOut "UniswapV2Router02.abi")
)

$artifactHashes = [ordered]@{}
foreach ($artifact in $artifactPaths) {
    $relative = $artifact.Substring($deploy.Length).TrimStart("\").Replace("\", "/")
    $artifactHashes[$relative] = (Get-FileHash -Algorithm SHA256 $artifact).Hash.ToLowerInvariant()
}

$manifest = [ordered]@{
    compiler = $compilerVersion
    optimizer = [ordered]@{ enabled = $true; runs = 999999 }
    metadataHash = "none"
    sourcePins = $sourcePins
    artifactSha256 = $artifactHashes
}

$manifestPath = Join-Path $deploy "contracts\v2-production-manifest.json"
$manifestJson = $manifest | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($manifestPath, $manifestJson, (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote reproducible V2 artifacts and manifest to $deploy\contracts"
