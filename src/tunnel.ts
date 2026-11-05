import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { EffectiveConfig } from './config.js';

/** Owns only the SSH process created by this plugin. Never closes user tunnels. */
export class Tunnel {
  private child?: ChildProcess;
  private opening?: Promise<void>;
  private identity = '';
  private idle?: ReturnType<typeof setTimeout>;
  private active = 0;
  async acquire(c: EffectiveConfig) {
    clearTimeout(this.idle);
    const identity = `${c.sshHost}:${c.localPort}:${c.remotePort}`;
    if (this.identity && this.identity !== identity) {
      if (this.active) throw Error('语音正在运行，请结束通话后修改连接设置');
      this.close();
    }
    this.identity = identity;
    if (c.sshHost && !this.child && !this.opening) {
      this.opening = this.open(c).finally(() => { this.opening = undefined; });
    }
    if (this.opening) await this.opening;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      if (!this.active && c.idleMinutes > 0) this.idle = setTimeout(() => this.close(), c.idleMinutes * 60_000);
      this.idle?.unref();
    };
  }
  private async open(c: EffectiveConfig) {
    if (c.remoteTaskName) await promisify(execFile)('ssh', ['-T','-o','BatchMode=yes','-o','ConnectTimeout=10',c.sshHost,'schtasks','/Run','/TN',c.remoteTaskName], {timeout:20000,windowsHide:true});
    const child = spawn('ssh', ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
      '-L', `127.0.0.1:${c.localPort}:127.0.0.1:${c.remotePort}`, c.sshHost], { stdio: ['ignore', 'ignore', 'pipe'] });
    let failure = '';
    child.stderr?.on('data', (part: Buffer) => { failure = (failure + part.toString()).slice(-1000); });
    child.on('error', e => { failure = e.message; });
    child.on('exit', () => { if (this.child === child) this.child = undefined; });
    this.child = child;
    // SSH listens before connecting, so TCP-open alone is insufficient. Probe authenticated gateway.
    for (let i = 0; i < 24; i++) {
      if (child.exitCode !== null || failure) break;
      try {
        const response = await fetch(`http://127.0.0.1:${c.localPort}/health`, {
          headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}, signal: AbortSignal.timeout(700),
        });
        if (response.ok) return;
        if (response.status === 401 || response.status === 403) { failure = '语音服务密钥不正确'; break; }
      } catch { /* Gateway may still be starting. */ }
      await delay(250);
    }
    if (this.child === child) this.close();
    throw Error(failure.trim() || '无法连接语音服务，请检查服务器网关和 SSH 配置');
  }
  close() {
    clearTimeout(this.idle);
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.identity = '';
  }
}
