import { ipcRenderer } from 'electron';
import { Component, createRef } from 'react';
import type ServiceModel from '../../../models/Service';

interface SignalHostStatus {
  serviceId: string;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
  version: string | null;
}

interface IProps {
  service: ServiceModel;
}

type IState = SignalHostStatus;

const initialStatus = (serviceId: string): SignalHostStatus => ({
  serviceId,
  state: 'stopped',
  error: null,
  version: null,
});

export default class SignalHostView extends Component<IProps, IState> {
  private readonly containerRef = createRef<HTMLDivElement>();

  private resizeObserver: ResizeObserver | null = null;

  private mutationObserver: MutationObserver | null = null;

  private boundsTimer: number | null = null;

  constructor(props: IProps) {
    super(props);
    this.state = initialStatus(props.service.id);
  }

  componentDidMount(): void {
    ipcRenderer.on('signal-host:state', this.handleStateChanged);

    this.resizeObserver = new ResizeObserver(this.scheduleSync);
    if (this.containerRef.current) {
      this.resizeObserver.observe(this.containerRef.current);
    }

    this.mutationObserver = new MutationObserver(this.scheduleSync);
    this.mutationObserver.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    window.addEventListener('resize', this.scheduleSync);
    window.addEventListener('scroll', this.scheduleSync, true);
    window.addEventListener('focus', this.scheduleSync);
    window.addEventListener('blur', this.scheduleSync);

    void this.loadStatus();
    this.scheduleSync();
  }

  componentDidUpdate(previousProps: IProps): void {
    if (
      previousProps.service.isActive !== this.props.service.isActive ||
      previousProps.service.isEnabled !== this.props.service.isEnabled
    ) {
      this.scheduleSync();
    }
  }

  componentWillUnmount(): void {
    ipcRenderer.removeListener('signal-host:state', this.handleStateChanged);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    window.removeEventListener('resize', this.scheduleSync);
    window.removeEventListener('scroll', this.scheduleSync, true);
    window.removeEventListener('focus', this.scheduleSync);
    window.removeEventListener('blur', this.scheduleSync);
    if (this.boundsTimer !== null) {
      window.clearTimeout(this.boundsTimer);
    }
    void ipcRenderer.invoke('signal-host:deactivate', this.props.service.id);
  }

  private readonly handleStateChanged = (
    _event: Electron.IpcRendererEvent,
    status: SignalHostStatus,
  ): void => {
    if (status?.serviceId === this.props.service.id) {
      this.setState(status);
    }
  };

  private async loadStatus(): Promise<void> {
    try {
      const status = (await ipcRenderer.invoke(
        'signal-host:status',
        this.props.service.id,
      )) as SignalHostStatus;
      this.setState(status);
    } catch (error) {
      this.setFailure(error);
    }
  }

  private readonly scheduleSync = (): void => {
    if (this.boundsTimer !== null) {
      window.clearTimeout(this.boundsTimer);
    }
    this.boundsTimer = window.setTimeout(() => {
      this.boundsTimer = null;
      void this.syncHost();
    }, 32);
  };

  private bounds(): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null {
    const element = this.containerRef.current;
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) {
      return null;
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  private isActuallyVisible(): boolean {
    const element = this.containerRef.current;
    if (!element || !this.props.service.isActive || !this.props.service.isEnabled) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const topElement = document.elementFromPoint(x, y);
    return Boolean(topElement && (topElement === element || element.contains(topElement)));
  }

  private async syncHost(): Promise<void> {
    const { service } = this.props;

    try {
      if (!this.isActuallyVisible()) {
        const status = (await ipcRenderer.invoke(
          'signal-host:deactivate',
          service.id,
        )) as SignalHostStatus;
        this.setState(status);
        return;
      }

      const bounds = this.bounds();
      if (!bounds) {
        return;
      }

      const status = (await ipcRenderer.invoke('signal-host:activate', {
        serviceId: service.id,
        bounds,
      })) as SignalHostStatus;
      this.setState(status);
    } catch (error) {
      this.setFailure(error);
    }
  }

  private setFailure(error: unknown): void {
    this.setState({
      serviceId: this.props.service.id,
      state: 'error',
      error: error instanceof Error ? error.message : String(error),
      version: this.state.version,
    });
  }

  private readonly retry = (): void => {
    this.setState({
      ...initialStatus(this.props.service.id),
      state: 'starting',
    });
    void this.syncHost();
  };

  render() {
    const { state, error, version } = this.state;
    const isVisible = this.props.service.isActive;

    return (
      <div
        ref={this.containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          background: '#f4f6fb',
          display: isVisible ? 'block' : 'none',
        }}
      >
        {state !== 'running' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 32,
              fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
              color: '#182033',
            }}
          >
            <div
              style={{
                width: 'min(620px, 90%)',
                padding: 28,
                borderRadius: 18,
                background: '#fff',
                boxShadow: '0 14px 42px rgba(26, 39, 72, 0.12)',
                textAlign: 'center',
              }}
            >
              <h2 style={{ margin: '0 0 12px', fontSize: 22 }}>
                {state === 'error'
                  ? 'Signal 启动失败'
                  : state === 'stopped'
                    ? '正在启动 Signal'
                    : '正在加载 Signal'}
              </h2>
              <p
                style={{
                  margin: 0,
                  lineHeight: 1.6,
                  color: '#667085',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {state === 'error'
                  ? error
                  : `账号数据已独立隔离${version ? ` · Signal ${version}` : ''}`}
              </p>
              {state === 'error' && (
                <button
                  type="button"
                  onClick={this.retry}
                  style={{
                    marginTop: 20,
                    padding: '10px 18px',
                    border: 0,
                    borderRadius: 9,
                    background: '#2f6df6',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 14,
                    fontWeight: 600,
                  }}
                >
                  重新启动
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
}
