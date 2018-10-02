/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { IPullRequest, IPullRequestManager, IPullRequestModel } from './interface';
import { onDidClosePR } from '../commands';
import { exec } from '../common/git';
import { formatError } from '../common/utils';
import { GitErrorCodes } from '../common/gitError';

export class PullRequestOverviewPanel {
	/**
	 * Track the currently panel. Only allow a single panel to exist at a time.
	 */
	public static currentPanel: PullRequestOverviewPanel | undefined;

	private static readonly _viewType = 'PullRequestOverview';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionPath: string;
	private _disposables: vscode.Disposable[] = [];
	private _pullRequest: IPullRequestModel;
	private _pullRequestManager: IPullRequestManager;
	private _initialized: boolean;

	public static createOrShow(extensionPath: string, pullRequestManager: IPullRequestManager, pullRequestModel: IPullRequestModel) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		// If we already have a panel, show it.
		// Otherwise, create a new panel.
		if (PullRequestOverviewPanel.currentPanel) {
			PullRequestOverviewPanel.currentPanel._panel.reveal(column, true);
		} else {
			const title = `Pull Request #${pullRequestModel.prNumber.toString()}`;
			PullRequestOverviewPanel.currentPanel = new PullRequestOverviewPanel(extensionPath, column || vscode.ViewColumn.One, title, pullRequestManager);
		}

		PullRequestOverviewPanel.currentPanel.update(pullRequestModel);
	}

	public static refresh():void {
		if (this.currentPanel) {
			this.currentPanel.refreshPanel();
		}
	}

	private constructor(extensionPath: string, column: vscode.ViewColumn, title: string, pullRequestManager: IPullRequestManager) {
		this._extensionPath = extensionPath;
		this._pullRequestManager = pullRequestManager;

		// Create and show a new webview panel
		this._panel = vscode.window.createWebviewPanel(PullRequestOverviewPanel._viewType, title, column, {
			// Enable javascript in the webview
			enableScripts: true,

			// And restric the webview to only loading content from our extension's `media` directory.
			localResourceRoots: [
				vscode.Uri.file(path.join(this._extensionPath, 'media'))
			]
		});

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Listen for changes to panel visibility, if the webview comes into view resubmit data
		this._panel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible) {
				this.update(this._pullRequest);
			}
		}, this, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(async message => {
			await this._onDidReceiveMessage(message);
		}, null, this._disposables);

		this._pullRequestManager.onDidChangeActivePullRequest(_ => {
			if (this._pullRequestManager && this._pullRequest) {
				const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
				this._panel.webview.postMessage({
					command: 'pr.update-checkout-status',
					isCurrentlyCheckedOut: isCurrentlyCheckedOut
				});
			}
		}, null, this._disposables);

		onDidClosePR(pr => {
			if (pr) {
				this._pullRequest.update(pr);
			}

			this._panel.webview.postMessage({
				command: 'update-state',
				state: this._pullRequest.state,
			});
		}, null, this._disposables);
	}

	public async refreshPanel(): Promise<void> {
		this._initialized = false;
		if (this._panel && this._panel.visible) {
			this.update(this._pullRequest);
		}
	}

	public async update(pullRequestModel: IPullRequestModel): Promise<void> {
		this._panel.webview.html = this.getHtmlForWebview(pullRequestModel.prNumber.toString());

		if (!pullRequestModel.equals(this._pullRequest) || !this._initialized) {
			this._pullRequest = pullRequestModel;
			this._initialized = true;
			this._panel.title = `Pull Request #${pullRequestModel.prNumber.toString()}`;

			const isCurrentlyCheckedOut = pullRequestModel.equals(this._pullRequestManager.activePullRequest);

			Promise.all(
				[
					this._pullRequestManager.getTimelineEvents(pullRequestModel),
					this._pullRequestManager.getPullRequestRepositoryDefaultBranch(pullRequestModel)
				]
			).then(result => {
				const [timelineEvents, defaultBranch] = result;
				this._panel.webview.postMessage({
					command: 'pr.initialize',
					pullrequest: {
						number: pullRequestModel.prNumber,
						title: pullRequestModel.title,
						url: pullRequestModel.html_url,
						createdAt: pullRequestModel.createdAt,
						body: pullRequestModel.body,
						author: pullRequestModel.author,
						state: pullRequestModel.state,
						events: timelineEvents,
						isCurrentlyCheckedOut: isCurrentlyCheckedOut,
						base: pullRequestModel.base && pullRequestModel.base.label || 'UNKNOWN',
						head: pullRequestModel.head && pullRequestModel.head.label || 'UNKNOWN',
						commitsCount: pullRequestModel.commitCount,
						repositoryDefaultBranch: defaultBranch
					}
				});
			});
		}
	}

	private async _onDidReceiveMessage(message) {
		switch (message.command) {
			case 'alert':
				vscode.window.showErrorMessage(message.text);
				return;
			case 'pr.checkout':
				return this.checkoutPullRequest();
			case 'pr.close':
				return this.closePullRequest(message.text);
			case 'pr.approve':
				return this.approvePullRequest(message.text);
			case 'pr.request-changes':
				return this.requestChanges(message.text);
			case 'pr.checkout-default-branch':
				return this.checkoutDefaultBranch(message.branch);
			case 'pr.comment':
				return this.createComment(message.text);
			case 'pr.edit-comment':
				return this.editComment(message.comment, message.text);
			case 'pr.delete-comment':
				return this.deleteComment(message.comment);
		}
	}

	private editComment(comment: vscode.Comment, text: string) {
		this._pullRequestManager.editComment(this._pullRequest, comment.commentId, text).then(result => {
			this._panel.webview.postMessage({
				command: 'pr.update-comment',
				comment: result
			});
		}).catch(e => {
			// TODO
			console.log(e);
		});
	}

	private deleteComment(comment: vscode.Comment) {
		vscode.window.showWarningMessage('Are you sure you want to delete this comment?', { modal: true }, 'Delete').then(value => {
			if (value === 'Delete') {
				this._pullRequestManager.deleteComment(this._pullRequest, comment.commentId).then(result => {
					this._panel.webview.postMessage({
						command: 'pr.update-comment',
						comment: result
					});
				}).catch(e => {
					// TODO
					console.log(e);
				});
			}
		});
	}

	private checkoutPullRequest(): void {
		vscode.commands.executeCommand('pr.pick', this._pullRequest).then(() => {}, () => {
			const isCurrentlyCheckedOut = this._pullRequest.equals(this._pullRequestManager.activePullRequest);
			this._panel.webview.postMessage({
				command: 'pr.update-checkout-status',
				isCurrentlyCheckedOut: isCurrentlyCheckedOut
			});
		});
	}

	private closePullRequest(message?: string): void {
		vscode.commands.executeCommand<IPullRequest>('pr.close', this._pullRequest, message).then(comment => {
			if (comment) {
				this._panel.webview.postMessage({
					command: 'pr.append-comment',
					value: comment
				});
			}
		});
	}

	private async checkoutDefaultBranch(branch: string): Promise<void> {
		try {
			// This should be updated for multi-root support and consume the git extension API if possible
			const result = await exec(['rev-parse', '--symbolic-full-name', '@{-1}'], {
				cwd: vscode.workspace.rootPath
			});

			if (result) {
				const branchFullName = result.stdout.trim();

				if (`refs/heads/${branch}` === branchFullName) {
					await this._pullRequestManager.checkout(branch);
				} else {
					await vscode.commands.executeCommand('git.checkout');
				}
			}
		} catch (e) {
			if (e.gitErrorCode) {
				// for known git errors, we should provide actions for users to continue.
				if (e.gitErrorCode === GitErrorCodes.LocalChangesOverwritten) {
					vscode.window.showErrorMessage('Your local changes would be overwritten by checkout, please commit your changes or stash them before you switch branches');
					this._panel.webview.postMessage({
						command: 'pr.enable-exit'
					});
					return;
				}
			}

			vscode.window.showErrorMessage(`Exiting failed: ${e}`);
			this._panel.webview.postMessage({
				command: 'pr.enable-exit'
			});
		}
	}

	private createComment(text: string) {
		this._pullRequestManager.createIssueComment(this._pullRequest, text).then(comment => {
			this._panel.webview.postMessage({
				command: 'pr.append-comment',
				value: comment
			});
		});
	}

	private approvePullRequest(message?: string): void {
		vscode.commands.executeCommand<IPullRequest>('pr.approve', this._pullRequest, message).then(review => {
			if (review) {
				this._panel.webview.postMessage({
					command: 'pr.append-review',
					value: review
				});
			}

			this._panel.webview.postMessage({
				command: 'pr.enable-approve'
			});
		}, (e) => {
			vscode.window.showErrorMessage(`Approving pull request failed. ${formatError(e)}`);

			this._panel.webview.postMessage({
				command: 'pr.enable-approve'
			});
		});
	}

	private requestChanges(message?: string): void {
		vscode.commands.executeCommand<IPullRequest>('pr.requestChanges', this._pullRequest, message).then(review => {
			if (review) {
				this._panel.webview.postMessage({
					command: 'pr.append-review',
					value: review
				});
			}
		}, (e) => {
			vscode.window.showErrorMessage(`Requesting changes failed. ${formatError(e)}`);

			this._panel.webview.postMessage({
				command: 'pr.enable-request-changes'
			});
		});
	}

	public dispose() {
		PullRequestOverviewPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private getHtmlForWebview(number: string) {
		const scriptPathOnDisk = vscode.Uri.file(path.join(this._extensionPath, 'media', 'index.js'));
		const scriptUri = scriptPathOnDisk.with({ scheme: 'vscode-resource' });
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Pull Request #${number}</title>
			</head>
			<body>
				<script nonce="${nonce}" src="${scriptUri}"></script>
				<div id="title" class="title"></div>
				<div id="timeline-events" class="discussion" aria-live="polite"></div>
				<div id="comment-form" class="comment-form"></div>
			</body>
			</html>`;
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}