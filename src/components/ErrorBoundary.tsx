import { Component, type ErrorInfo, type ReactNode } from 'react';
import { gateway } from '../gateway/client';
import { downloadDiagnostics } from '../lib/diagnostics';
import { Button } from './ui/button';
import { Card } from './ui/card';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 兜住渲染期异常：交易数据都在网关和本地库里，重新加载即可继续。
 * 崩溃时提供一键诊断包，避免用户只能复述现象。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Tally 渲染失败', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar p-6 text-foreground">
        <Card className="w-full max-w-md gap-0 rounded-xl p-6">
          <h1 className="text-lg font-semibold">界面出错了</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            交易数据仍保存在网关里，重新加载即可继续。先导出一份诊断包再反馈，能省下大量排查时间。
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap text-destructive-foreground">
            {error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <Button
              className="h-9 flex-1 text-[12px]"
              onClick={() => window.location.reload()}
            >
              重新加载
            </Button>
            <Button
              variant="outline"
              className="h-9 flex-1 text-[12px]"
              onClick={() => void downloadDiagnostics(gateway)}
            >
              导出诊断
            </Button>
          </div>
        </Card>
      </div>
    );
  }
}
