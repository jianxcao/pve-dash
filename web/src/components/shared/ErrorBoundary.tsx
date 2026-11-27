import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
  resetKey?: string
}

interface State {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || '页面渲染发生未知错误' }
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: '' })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('PVE Dash UI ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center text-foreground">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-destructive/40 bg-destructive/12 text-destructive">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div className="space-y-1 max-w-md">
            <h2 className="text-lg font-semibold">界面出现意外异常</h2>
            <p className="text-xs font-mono-num text-muted-foreground break-all">
              {this.state.message}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => this.setState({ hasError: false, message: '' })}
            >
              尝试恢复
            </Button>
            <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
              <RotateCcw className="h-3.5 w-3.5" />
              重新加载页面
            </Button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
