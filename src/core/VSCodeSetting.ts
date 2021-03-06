import * as fs from "fs-extra";
import * as junk from "junk";
import * as minimatch from "minimatch";
import * as path from "path";

import
{
    CONFIGURATION_EXCLUDED_EXTENSIONS,
    CONFIGURATION_EXCLUDED_SETTINGS,
    CONFIGURATION_KEY,
    CONFIGURATION_POKA_YOKE_THRESHOLD,
    CONFIGURATION_SEPARATE_KEYBINDINGS,
    SETTING_EXCLUDED_EXTENSIONS,
    SETTING_EXCLUDED_SETTINGS
} from "../common/constants";
import { localize } from "../i18n";
import * as GitHubTypes from "../types/GitHubTypes";
import { IExtension, ISetting, ISyncedItem, SettingTypes } from "../types/SyncingTypes";
import { diff } from "../utils/diffPatch";
import { excludeSettings, mergeSettings, parse } from "../utils/jsonc";
import { getVSCodeSetting } from "../utils/vscodeAPI";
import { Environment } from "./Environment";
import { Extension } from "./Extension";
import * as Toast from "./Toast";

/**
 * `VSCode Settings` wrapper.
 */
export class VSCodeSetting
{
    private static _instance: VSCodeSetting;

    /**
     * Suffix of remote mac files.
     */
    private static readonly MAC_SUFFIX: string = "-mac";

    /**
     * Prefix of remote snippet files.
     */
    private static readonly SNIPPET_PREFIX: string = "snippet-";

    private _env: Environment;
    private _ext: Extension;

    private constructor()
    {
        this._env = Environment.create();
        this._ext = Extension.create();
    }

    /**
     * Creates an instance of singleton class `VSCodeSetting`.
     */
    public static create(): VSCodeSetting
    {
        if (!VSCodeSetting._instance)
        {
            VSCodeSetting._instance = new VSCodeSetting();
        }
        return VSCodeSetting._instance;
    }

    /**
     * Gets `VSCode Settings` (which will be uploaded or downloaded, anyway).
     * For example:
     *    [
     *        {
     *            name: "extensions",
     *            path: "C:\\Users\\AppData\\Roaming\\Code\\User\\extensions.json",
     *            remote: "extensions.json",
     *            content: "// init"
     *        },
     *        ...
     *    ]
     *
     * @param {boolean} [loadFileContent=false] Whether to load the content of `VSCode Settings` files. Defaults to `false`.
     * @param {boolean} [showIndicator=false] Whether to show the progress indicator. Defaults to `false`.
     */
    public async getSettings(loadFileContent: boolean = false, showIndicator: boolean = false): Promise<ISetting[]>
    {
        if (showIndicator)
        {
            Toast.showSpinner(localize("toast.settings.gathering.local"));
        }

        // Note that this is an ordered list, to ensure that the smaller files (such as `settings.json`, `keybindings.json`) are synced first.
        // Thus, the extensions will be the last one to sync.
        const settingsList = [
            SettingTypes.Settings,
            SettingTypes.Keybindings,
            SettingTypes.Locale,
            SettingTypes.Snippets,
            SettingTypes.Extensions
        ];

        const errorFiles: string[] = [];
        const results: ISetting[] = [];
        let localFilename: string;
        let remoteFilename: string;
        let tempSettings: ISetting[];

        for (const type of settingsList)
        {
            if (type === SettingTypes.Snippets)
            {
                // Attention: Snippets may be empty.
                tempSettings = await this._getSnippets(this._env.snippetsDirectory);
            }
            else
            {
                localFilename = `${type}.json`;
                remoteFilename = localFilename;
                if (type === SettingTypes.Keybindings)
                {
                    // Separate the keybindings.
                    const separateKeybindings = getVSCodeSetting<boolean>(CONFIGURATION_KEY, CONFIGURATION_SEPARATE_KEYBINDINGS);
                    if (separateKeybindings)
                    {
                        remoteFilename = this._env.isMac
                            ? `${type}${VSCodeSetting.MAC_SUFFIX}.json`
                            : `${type}.json`;
                    }
                    else
                    {
                        remoteFilename = `${type}.json`;
                    }
                }

                tempSettings = [{
                    filepath: path.join(this._env.codeUserDirectory, localFilename),
                    remoteFilename,
                    type
                }];
            }

            if (loadFileContent)
            {
                const values = await this._loadContent(tempSettings);
                values.forEach((value: ISetting) =>
                {
                    // Success if the content is not `null`.
                    if (value.content)
                    {
                        results.push(value);
                    }
                    else
                    {
                        errorFiles.push(value.remoteFilename);
                    }
                });
            }
            else
            {
                results.push(...tempSettings);
            }
        }

        if (errorFiles.length > 0)
        {
            console.error(localize("error.invalid.settings", errorFiles.join(" ")));
        }

        if (showIndicator)
        {
            Toast.clearSpinner("");
        }
        return results;
    }

    /**
     * Save `VSCode Settings` to files.
     *
     * @param files `VSCode Settings` from GitHub Gist.
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */
    public async saveSettings(files: GitHubTypes.IGistFiles, showIndicator: boolean = false): Promise<{
        updated: ISyncedItem[],
        removed: ISyncedItem[]
    }>
    {
        if (showIndicator)
        {
            Toast.showSpinner(localize("toast.settings.downloading"));
        }

        try
        {
            if (files)
            {
                const existsFileKeys: string[] = [];
                const settingsToRemove: ISetting[] = [];
                const settingsToSave: ISetting[] = [];
                let extensionsSetting: ISetting | undefined;
                let gistFile: GitHubTypes.IGistFile;

                const settings = await this.getSettings();
                for (const setting of settings)
                {
                    gistFile = files[setting.remoteFilename];
                    if (gistFile)
                    {
                        // If the file exists in both remote and local, it should be synchronized.
                        if (setting.type === SettingTypes.Extensions)
                        {
                            // Temp extensions file.
                            extensionsSetting = {
                                ...setting,
                                content: gistFile.content
                            };
                        }
                        else
                        {
                            // Temp other file.
                            settingsToSave.push({
                                ...setting,
                                content: gistFile.content
                            });
                        }
                        existsFileKeys.push(setting.remoteFilename);
                    }
                    else
                    {
                        // File exists in remote, but not exists in local.
                        // Delete if it's a snippet file.
                        if (setting.type === SettingTypes.Snippets)
                        {
                            settingsToRemove.push(setting);
                        }
                    }
                }

                let filename: string;
                for (const key of Object.keys(files))
                {
                    if (existsFileKeys.indexOf(key) === -1)
                    {
                        gistFile = files[key];
                        if (gistFile.filename.startsWith(VSCodeSetting.SNIPPET_PREFIX))
                        {
                            // Snippets.
                            filename = gistFile.filename.slice(VSCodeSetting.SNIPPET_PREFIX.length);
                            if (filename)
                            {
                                settingsToSave.push({
                                    content: gistFile.content,
                                    filepath: this._env.getSnippetFilePath(filename),
                                    remoteFilename: gistFile.filename,
                                    type: SettingTypes.Snippets
                                });
                            }
                        }
                        else
                        {
                            // Unknown files, don't care.
                        }
                    }
                }

                // Put extensions file to the last.
                if (extensionsSetting)
                {
                    settingsToSave.push(extensionsSetting);
                }

                // poka-yoke - Determines whether there're too much changes since the last downloading.
                const value = await this._shouldContinue(settings, settingsToSave, settingsToRemove);
                if (value)
                {
                    const syncedItems: {
                        updated: ISyncedItem[],
                        removed: ISyncedItem[]
                    } = { updated: [], removed: [] };

                    // Save settings.
                    for (const setting of settingsToSave)
                    {
                        try
                        {
                            const saved = await this._saveSetting(setting);
                            syncedItems.updated.push(saved);
                        }
                        catch (error)
                        {
                            throw new Error(localize("error.save.file", setting.remoteFilename, error.message));
                        }
                    }

                    // Remove settings.
                    const removed = await this.removeSettings(settingsToRemove);
                    syncedItems.removed = removed;

                    if (showIndicator)
                    {
                        Toast.clearSpinner("");
                    }
                    return syncedItems;
                }
                else
                {
                    throw new Error(localize("error.abort.synchronization"));
                }
            }
            else
            {
                throw new Error(localize("error.gist.files.notfound"));
            }
        }
        catch (error)
        {
            if (showIndicator)
            {
                Toast.statusError(localize("toast.settings.downloading.failed", error.message));
            }
            throw error;
        }
    }

    /**
     * Delete the physical files corresponding to the `VSCode Settings`.
     *
     * @param settings `VSCode Settings`.
     */
    public async removeSettings(settings: ISetting[]): Promise<ISyncedItem[]>
    {
        const removed: ISyncedItem[] = [];
        for (const setting of settings)
        {
            try
            {
                await fs.remove(setting.filepath);
                removed.push({ setting });
            }
            catch (error)
            {
                throw new Error(localize("error.remove.file", setting.remoteFilename, error.message));
            }
        }
        return removed;
    }

    /**
     * Gets all local snippet files.
     *
     * @param snippetsDir Snippets dir.
     */
    private async _getSnippets(snippetsDir: string): Promise<ISetting[]>
    {
        const results: ISetting[] = [];
        try
        {
            const filenames = await fs.readdir(snippetsDir);
            filenames.filter(junk.not).forEach((filename: string) =>
            {
                // Add prefix to all snippets.
                results.push({
                    filepath: path.join(snippetsDir, filename),
                    remoteFilename: `${VSCodeSetting.SNIPPET_PREFIX}${filename}`,
                    type: SettingTypes.Snippets
                });
            });
        }
        catch (err)
        {
            console.error(localize("error.loading.snippets"));
        }
        return results;
    }

    /**
     * Load the content of `VSCode Settings` files. The `content` will exactly be `undefined` when failure happens.
     *
     * @param settings `VSCode Settings`.
     * @param exclude Default is `true`, exclude some `VSCode Settings` base on the exclude list of `Syncing`.
     */
    private async _loadContent(settings: ISetting[], exclude: boolean = true): Promise<ISetting[]>
    {
        return settings.map((setting: ISetting) =>
        {
            let content: string | undefined;
            try
            {
                if (setting.type === SettingTypes.Extensions)
                {
                    // Exclude extensions.
                    let extensions = this._ext.getAll();
                    if (exclude && extensions.length > 0)
                    {
                        const patterns = getVSCodeSetting<string[]>(CONFIGURATION_KEY, CONFIGURATION_EXCLUDED_EXTENSIONS);
                        extensions = this._getExcludedExtensions(extensions, patterns);
                    }
                    content = JSON.stringify(extensions, null, 4);
                }
                else
                {
                    content = fs.readFileSync(setting.filepath, "utf8");

                    // Exclude settings.
                    if (exclude && content && setting.type === SettingTypes.Settings)
                    {
                        const settingsJSON = parse(content);
                        if (settingsJSON)
                        {
                            const patterns = getVSCodeSetting<string[]>(CONFIGURATION_KEY, CONFIGURATION_EXCLUDED_SETTINGS);
                            content = excludeSettings(content, settingsJSON, patterns);
                        }
                    }
                }
            }
            catch (err)
            {
                content = undefined;
                console.error(localize("error.loading.settings", setting.remoteFilename, err));
            }

            return { ...setting, content };
        });
    }

    /**
     * Save `VSCode Setting` to file or sync extensions.
     *
     * @param setting `VSCode Setting`.
     */
    private async _saveSetting(setting: ISetting): Promise<ISyncedItem>
    {
        let result: ISyncedItem;
        if (setting.type === SettingTypes.Extensions)
        {
            // Sync extensions.
            const extensions: IExtension[] = parse(setting.content || "[]");
            result = await this._ext.sync(extensions, true);
        }
        else
        {
            let settingsToSave = setting.content;
            if (setting.type === SettingTypes.Settings && settingsToSave)
            {
                // Sync settings.
                const localFiles = await this._loadContent([setting], false);
                const localSettings = localFiles[0] && localFiles[0].content;
                if (localSettings)
                {
                    // Merge remote and local settings.
                    settingsToSave = mergeSettings(settingsToSave, localSettings);
                }
            }

            // Save to disk.
            result = await this._saveToFile({ ...setting, content: settingsToSave });
        }
        return result;
    }

    /**
     * Save the `VSCode Setting` to disk.
     */
    private _saveToFile(setting: ISetting)
    {
        return fs.outputFile(setting.filepath, setting.content || "{}").then(() => ({ setting } as ISyncedItem));
    }

    /**
     * Determines whether the downloading should continue.
     */
    private async _shouldContinue(
        settings: ISetting[],
        settingsToSave: ISetting[],
        settingsToRemove: ISetting[]
    ): Promise<boolean>
    {
        let result = true;
        const threshold = getVSCodeSetting<number>(CONFIGURATION_KEY, CONFIGURATION_POKA_YOKE_THRESHOLD);
        if (threshold > 0)
        {
            const localSettings = await this._loadContent(settings, false);

            // poka-yoke - Determines whether there're too much changes since the last uploading.
            // 1. Excluded settings.
            // Here clone the settings to avoid manipulation.
            let excludedSettings = this._excludeSettings(
                localSettings,
                settingsToSave.map((setting) => ({ ...setting })),
                SettingTypes.Settings
            );

            // 2. Excluded extensions.
            excludedSettings = this._excludeSettings(
                excludedSettings.localSettings,
                excludedSettings.remoteSettings,
                SettingTypes.Extensions
            );

            // 3. Diff settings.
            const changes = settingsToRemove.length
                + this._diffSettings(excludedSettings.localSettings, excludedSettings.remoteSettings);
            if (changes >= threshold)
            {
                const okButton = localize("pokaYoke.continue.download");
                const message = localize("pokaYoke.continue.download.message");
                const selection = await Toast.showConfirmBox(message, okButton, localize("pokaYoke.cancel"));
                result = (selection === okButton);
            }
        }
        return result;
    }

    /**
     * Excludes settings based on the excluded setting of remote settings.
     */
    private _excludeSettings(localSettings: ISetting[], remoteSettings: ISetting[], type: SettingTypes)
    {
        const lSetting = localSettings.find((setting) => (setting.type === type));
        const rSetting = remoteSettings.find((setting) => (setting.type === type));
        if (lSetting && lSetting.content && rSetting && rSetting.content)
        {
            const lSettingJSON = parse(lSetting.content);
            const rSettingJSON = parse(rSetting.content);
            if (lSettingJSON && rSettingJSON)
            {
                if (type === SettingTypes.Settings)
                {
                    // Exclude settings.
                    const patterns = rSettingJSON[SETTING_EXCLUDED_SETTINGS] || [];
                    lSetting.content = excludeSettings(lSetting.content, lSettingJSON, patterns);
                    rSetting.content = excludeSettings(rSetting.content, rSettingJSON, patterns);
                }
                else if (type === SettingTypes.Extensions)
                {
                    // Exclude extensions.
                    const rVSCodeSettings = remoteSettings.find((setting) => (setting.type === SettingTypes.Settings));
                    if (rVSCodeSettings && rVSCodeSettings.content)
                    {
                        const rVSCodeSettingsJSON = parse(rVSCodeSettings.content);
                        if (rVSCodeSettingsJSON)
                        {
                            const patterns: string[] = rVSCodeSettingsJSON[SETTING_EXCLUDED_EXTENSIONS] || [];
                            lSetting.content = JSON.stringify(this._getExcludedExtensions(lSettingJSON, patterns));
                            rSetting.content = JSON.stringify(this._getExcludedExtensions(rSettingJSON, patterns));
                        }
                    }
                }
            }
        }
        return { localSettings, remoteSettings };
    }

    /**
     * Gets excluded extensions based on the excluded setting of remote settings.
     */
    private _getExcludedExtensions(extensions: IExtension[], patterns: string[])
    {
        return extensions.filter((ext) =>
        {
            return !patterns.some((pattern) => minimatch(ext.id, pattern));
        });
    }

    /**
     * Calculates the number of differences between the local and remote settings.
     */
    private _diffSettings(localSettings: ISetting[], remoteSettings: ISetting[]): number
    {
        const left = this._parseToJSON(localSettings);
        const right = this._parseToJSON(remoteSettings);
        return diff(left, right);
    }

    /**
     * Converts the `content` of `ISetting[]` into a `JSON object`.
     */
    private _parseToJSON(settings: ISetting[]): object
    {
        let parsed: object;
        let content: string;
        const result = {};
        for (const setting of settings)
        {
            content = setting.content || "";
            parsed = parse(content);

            if (setting.type === SettingTypes.Extensions && Array.isArray(parsed))
            {
                for (const ext of parsed)
                {
                    if (ext["id"] != null)
                    {
                        ext["id"] = ext["id"].toLocaleLowerCase();
                    }

                    // Only compares id and version.
                    delete ext["name"];
                    delete ext["publisher"];
                    delete ext["uuid"];
                }
            }

            result[setting.remoteFilename] = parsed || content;
        }
        return result;
    }
}
