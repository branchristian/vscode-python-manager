// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { ProgressOptions, ProgressLocation, MarkdownString, WorkspaceFolder } from 'vscode';
import { IExtensionActivationService } from '../../activation/types';
import { IApplicationShell, IApplicationEnvironment, IWorkspaceService } from '../../common/application/types';
import { IPlatformService } from '../../common/platform/types';
import { identifyShellFromShellPath } from '../../common/terminal/shellDetectors/baseShellDetector';
import {
    IExtensionContext,
    Resource,
    IDisposableRegistry,
    IConfigurationService,
    IPathUtils,
} from '../../common/types';
import { Deferred, createDeferred } from '../../common/utils/async';
import { Interpreters } from '../../common/utils/localize';
import { traceDecoratorVerbose, traceVerbose } from '../../logging';
import { IInterpreterService } from '../contracts';
import { defaultShells } from './service';
import { IEnvironmentActivationService, ITerminalEnvVarCollectionService } from './types';
import { EnvironmentVariables } from '../../common/variables/types';

@injectable()
export class TerminalEnvVarCollectionService implements IExtensionActivationService, ITerminalEnvVarCollectionService {
    public readonly supportedWorkspaceTypes = {
        untrustedWorkspace: false,
        virtualWorkspace: false,
    };

    private deferred: Deferred<void> | undefined;

    private registeredOnce = false;

    /**
     * Carries default environment variables for the currently selected shell.
     */
    private processEnvVars: EnvironmentVariables | undefined;

    constructor(
        @inject(IPlatformService) private readonly platform: IPlatformService,
        @inject(IInterpreterService) private interpreterService: IInterpreterService,
        @inject(IExtensionContext) private context: IExtensionContext,
        @inject(IApplicationShell) private shell: IApplicationShell,
        @inject(IApplicationEnvironment) private applicationEnvironment: IApplicationEnvironment,
        @inject(IDisposableRegistry) private disposables: IDisposableRegistry,
        @inject(IEnvironmentActivationService) private environmentActivationService: IEnvironmentActivationService,
        @inject(IWorkspaceService) private workspaceService: IWorkspaceService,
        @inject(IConfigurationService) private readonly configurationService: IConfigurationService,
        @inject(IPathUtils) private readonly pathUtils: IPathUtils,
    ) {}

    isTerminalPromptSetCorrectly(_resource?: Resource): boolean {
        return true;
    }

    public async activate(resource: Resource): Promise<void> {
        // if (!inTerminalEnvVarExperiment(this.experimentService)) {
        //     this.context.environmentVariableCollection.clear();
        //     await this.handleMicroVenv(resource);
        //     if (!this.registeredOnce) {
        //         this.interpreterService.onDidChangeInterpreter(
        //             async (r) => {
        //                 await this.handleMicroVenv(r);
        //             },
        //             this,
        //             this.disposables,
        //         );
        //         this.registeredOnce = true;
        //     }
        //     return;
        // }
        if (!this.registeredOnce) {
            this.interpreterService.onDidChangeInterpreter(
                async (r) => {
                    this.showProgress();
                    await this._applyCollection(r).ignoreErrors();
                    this.hideProgress();
                },
                this,
                this.disposables,
            );
            this.applicationEnvironment.onDidChangeShell(
                async (shell: string) => {
                    this.showProgress();
                    this.processEnvVars = undefined;
                    // Pass in the shell where known instead of relying on the application environment, because of bug
                    // on VSCode: https://github.com/microsoft/vscode/issues/160694
                    await this._applyCollection(undefined, shell).ignoreErrors();
                    this.hideProgress();
                },
                this,
                this.disposables,
            );
            this.registeredOnce = true;
        }
        this._applyCollection(resource).ignoreErrors();
    }

    public async _applyCollection(resource: Resource, shell = this.applicationEnvironment.shell): Promise<void> {
        const workspaceFolder = this.getWorkspaceFolder(resource);
        const settings = this.configurationService.getSettings(resource);
        const envVarCollection = this.context.getEnvironmentVariableCollection({ workspaceFolder });
        // Clear any previously set env vars from collection
        envVarCollection.clear();
        if (!settings.terminal.activateEnvironment) {
            traceVerbose('Activating environments in terminal is disabled for', resource?.fsPath);
            return;
        }
        const env = await this.environmentActivationService.getActivatedEnvironmentVariables(
            resource,
            undefined,
            undefined,
            shell,
        );
        if (!env) {
            const shellType = identifyShellFromShellPath(shell);
            const defaultShell = defaultShells[this.platform.osType];
            if (defaultShell?.shellType !== shellType) {
                // Commands to fetch env vars may fail in custom shells due to unknown reasons, in that case
                // fallback to default shells as they are known to work better.
                await this._applyCollection(resource, defaultShell?.shell);
                return;
            }
            this.processEnvVars = undefined;
            return;
        }
        if (!this.processEnvVars) {
            this.processEnvVars = await this.environmentActivationService.getProcessEnvironmentVariables(
                resource,
                shell,
            );
        }
        const processEnv = this.processEnvVars;
        Object.keys(env).forEach((key) => {
            if (shouldSkip(key)) {
                return;
            }
            const value = env[key];
            const prevValue = processEnv[key];
            if (prevValue !== value) {
                if (value !== undefined) {
                    if (key === 'PS1') {
                        // We cannot have the full PS1 without executing in terminal, which we do not. Hence prepend it.
                        traceVerbose(`Prepending environment variable ${key} in collection with ${value}`);
                        envVarCollection.prepend(key, value, {
                            applyAtShellIntegration: true,
                            applyAtProcessCreation: false,
                        });
                        return;
                    }
                    traceVerbose(`Setting environment variable ${key} in collection to ${value}`);
                    envVarCollection.replace(key, value, {
                        applyAtShellIntegration: true,
                        applyAtProcessCreation: true,
                    });
                }
            }
        });

        const displayPath = this.pathUtils.getDisplayName(settings.pythonPath, workspaceFolder?.uri.fsPath);
        const description = new MarkdownString(`${Interpreters.activateTerminalDescription} \`${displayPath}\``);
        envVarCollection.description = description;
    }

    private getWorkspaceFolder(resource: Resource): WorkspaceFolder | undefined {
        let workspaceFolder = this.workspaceService.getWorkspaceFolder(resource);
        if (
            !workspaceFolder &&
            Array.isArray(this.workspaceService.workspaceFolders) &&
            this.workspaceService.workspaceFolders.length > 0
        ) {
            [workspaceFolder] = this.workspaceService.workspaceFolders;
        }
        return workspaceFolder;
    }

    @traceDecoratorVerbose('Display activating terminals')
    private showProgress(): void {
        if (!this.deferred) {
            this.createProgress();
        }
    }

    @traceDecoratorVerbose('Hide activating terminals')
    private hideProgress(): void {
        if (this.deferred) {
            this.deferred.resolve();
            this.deferred = undefined;
        }
    }

    private createProgress() {
        const progressOptions: ProgressOptions = {
            location: ProgressLocation.Window,
            title: Interpreters.activatingTerminals,
        };
        this.shell.withProgress(progressOptions, () => {
            this.deferred = createDeferred();
            return this.deferred.promise;
        });
    }
}

function shouldSkip(env: string) {
    return ['_', 'SHLVL'].includes(env);
}