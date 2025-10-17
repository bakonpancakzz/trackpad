import discord from "discord-rpc";
import vscode from "vscode";
import fs from "fs/promises";
import path from "path";

type WakatimeTotal = {
    decimal: string;        // 1.23
    digital: string;        // 1:23
    seconds: number;        // 123.456
    text: string;           // 1 hr 4 mins
}

const
    DISCORD_CLIENT_ID = "1323609388442849280",
    DISCORD_RPC = new discord.Client({ transport: "ipc" }),
    APP_CONFIG = vscode.workspace.getConfiguration("trackpad"),
    APP_CACHE_LOC: Record<string, { modtime: number; count: number; }> = {},
    DEFAULT_WAKATIME_DATA: WakatimeTotal = {
        "decimal": "0",
        "digital": "0:00",
        "seconds": 0.00,
        "text": "0s",
    }

discord.register(DISCORD_CLIENT_ID)

/** Calculate the Lines of Code for a Given Directory */
async function directoryCountLOC(
    rootDirectory: string,
    allowedExtensions: Set<string>,
    ignoredDirectories: Set<string>,
): Promise<number> {

    // Scan Directory Recursively
    let totalCount = 0
    async function checkDirectory(directory: string) {
        const entries = await fs.readdir(directory, { withFileTypes: true })
        for await (const file of entries) {
            const filepath = path.join(directory, file.name)

            // Sanity Checks
            if (file.isSymbolicLink()) continue
            if (file.isDirectory()) {
                if (ignoredDirectories.has(file.name)) continue
                await checkDirectory(filepath)
                continue
            }
            if (!file.isFile()) continue
            if (!allowedExtensions.has(path.extname(file.name))) continue

            // Use Cache if file was unmodified
            const filestat = await fs.stat(filepath)
            const cached = APP_CACHE_LOC[filepath]
            if (cached && cached.modtime == filestat.mtimeMs) {
                totalCount += cached.count
                continue
            }

            // Calculate LOC for Document
            const lineCount = (await fs.readFile(filepath, "utf8"))
                .replaceAll(/\/\*[\s\S]*?\*\//g, "")              // Ignore Comments: Multiline
                .split("\n")
                .filter(l => l.length !== 0)                        // Ignore Empty Lines
                .filter(l => !l.startsWith("#"))                    // Ignore Comments: Python
                .filter(l => !l.startsWith("//"))                   // Ignore Comments: JavaScript
                .filter(l => !l.startsWith("--"))                   // Ignore Comments: SQL
                .filter(l => !l.startsWith("@REM"))                 // Ignore Comments: Batch
                .length

            // Cache and Append Result
            APP_CACHE_LOC[filepath] = {
                modtime: filestat.mtimeMs,
                count: lineCount,
            }
            totalCount += lineCount
        }
    }

    await checkDirectory(rootDirectory)
    return totalCount
}

/** Fetch Todays Cummulative Time from Wakatime API */
async function wakatimeFetchSummary(apiKey?: string): Promise<WakatimeTotal> {
    if (!apiKey) return DEFAULT_WAKATIME_DATA
    try {
        // Fetch Data from API
        const today = new Date()
        const range = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`
        const response = await fetch(
            `https://wakatime.com/api/v1/users/current/summaries?start=${range}&end=${range}`, {
            headers: {
                "Authorization": `Basic ${btoa(apiKey)}`
            },
        })
        if (response.status >= 200 && response.status <= 299) {
            // Parse Content
            const data: any = await response.json()
            return data?.cumulative_total ?? DEFAULT_WAKATIME_DATA
        } else {
            vscode.window.showErrorMessage(`Wakatime API Returned Status Code ${response.status}\n`)
            return DEFAULT_WAKATIME_DATA
        }

    } catch (err) {
        // Fatal Network Error
        vscode.window.showErrorMessage(`Wakatime Error: ${err}`)
        return DEFAULT_WAKATIME_DATA
    }
}

/** Use Templates and Setup Discord Rich Presence */
async function updateRPC() {
    let activityDetails = "Idle"
    let activityState: string | undefined

    const workspaceFolders = vscode.workspace.workspaceFolders
    if (workspaceFolders && workspaceFolders.length > 0) {

        // Prepare Template Data
        const workspaceName = vscode.workspace.name ?? path.basename(workspaceFolders[0].uri.fsPath)
        let workspaceLOC = 0
        for await (const folder of workspaceFolders) {
            workspaceLOC += await directoryCountLOC(
                folder.uri.fsPath,
                new Set<string>(APP_CONFIG.get("allowedExtensions")),
                new Set<string>(APP_CONFIG.get("ignoredDirectories")),
            )
        }
        const wakatimeData = await wakatimeFetchSummary(
            APP_CONFIG.get("wakatimeKey"),
        )

        // Apply Template
        function useTemplate(givenText: string): string {
            return givenText
                .replaceAll("{workspace.name}", workspaceName)
                .replaceAll("{workspace.loc}", workspaceLOC.toLocaleString())
                .replaceAll("{wakatime.decimal}", wakatimeData.decimal)
                .replaceAll("{wakatime.digital}", wakatimeData.digital)
                .replaceAll("{wakatime.seconds}", (wakatimeData.seconds | 0).toString())
                .replaceAll("{wakatime.text}", wakatimeData.text)
        }
        activityDetails = useTemplate(APP_CONFIG.get("activityDetails", ""))
        activityState = useTemplate(APP_CONFIG.get("activityState", ""))
    }

    // Update Activity
    DISCORD_RPC.setActivity({
        details: activityDetails,
        state: activityState,
        largeImageKey: "vscode",
        largeImageText: "Visual Studio Code",
        smallImageKey: APP_CONFIG.get("overrideSmallIcon") || undefined,
        smallImageText: APP_CONFIG.get("overrideSmallText") || undefined,
        instance: false
    })
}

/** Extension Entrypoints */
export async function activate(context: vscode.ExtensionContext) {

    // Setup Discord Presence
    DISCORD_RPC.login({ clientId: DISCORD_CLIENT_ID }).catch(error => {
        vscode.window.showErrorMessage("Discord RPC Error: " + String(error))
    })
    DISCORD_RPC.on("ready", () => {
        setInterval(updateRPC, 300_000)
        updateRPC()
    })

    // Setup Extension
    vscode.commands.registerCommand("trackpad.refresh", () => {
        vscode.window.showInformationMessage("Refreshing Discord Rich Presence!")
        updateRPC()
    })
    context.subscriptions.push(
        vscode.Disposable.from({
            dispose: () => DISCORD_RPC.destroy()
        })
    )
}
export async function deactivate() {
    if (DISCORD_RPC) DISCORD_RPC.destroy()
}
