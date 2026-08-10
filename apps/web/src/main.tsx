import { StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Layout, Nav, Switch, Tag, Typography } from '@douyinfe/semi-ui';
import { IconAlertTriangle, IconFile, IconFolder, IconHistogram, IconHome, IconMoon, IconSearch, IconSetting, IconSun } from '@douyinfe/semi-icons';
import '../node_modules/@douyinfe/semi-ui/dist/css/semi.css';
import './styles.css';
const copy = { zh: { overview: '运行总览', projects: '项目', troubleshooting: '排障中心', logs: '日志', reports: '报表', settings: '设置', title: '运行状态，一目了然', scan: '扫描项目', scanHint: '识别 package.json / PM2 配置', managed: '托管项目', apps: '运行应用', stable: '守护可用性', attention: '需排障', local: '本机服务正常' }, en: { overview: 'Overview', projects: 'Projects', troubleshooting: 'Troubleshooting', logs: 'Logs', reports: 'Reports', settings: 'Settings', title: 'Your local runtime, at a glance', scan: 'Scan projects', scanHint: 'Detect package.json / PM2 config', managed: 'Managed projects', apps: 'Running apps', stable: 'Supervisor uptime', attention: 'Needs attention', local: 'Local daemon healthy' } };
function Dashboard(): ReactElement {
  const [dark, setDark] = useState(false);
  const [locale, setLocale] = useState<'zh' | 'en'>('zh');
  const t = copy[locale];
  const metrics = [
    { value: 12, label: t.managed, kind: 'blue' },
    { value: 18, label: t.apps, kind: 'green' },
    { value: '99.94%', label: t.stable, kind: 'purple' },
    { value: 1, label: t.attention, kind: 'orange' }
  ];
  return <div className={dark ? 'semi-always-dark' : 'semi-always-light'}><Layout className="shell"><Layout.Sider className="sider"><div className="brand">◫ Dockyard</div><Nav selectedKeys={['overview']} items={[{ itemKey: 'overview', text: t.overview, icon: <IconHome /> }, { itemKey: 'projects', text: t.projects, icon: <IconFolder /> }, { itemKey: 'troubleshooting', text: t.troubleshooting, icon: <IconAlertTriangle /> }, { itemKey: 'logs', text: t.logs, icon: <IconFile /> }, { itemKey: 'reports', text: t.reports, icon: <IconHistogram /> }]} /><Nav className="settings-nav" items={[{ itemKey: 'settings', text: t.settings, icon: <IconSetting /> }]} /></Layout.Sider><Layout className="main"><Layout.Header className="topbar"><Switch checked={locale === 'en'} checkedText="EN" uncheckedText="中" onChange={(v) => setLocale(v ? 'en' : 'zh')} /><Button theme="borderless" icon={dark ? <IconSun /> : <IconMoon />} onClick={() => setDark(!dark)} /><span className="daemon-status"><i />{t.local}</span></Layout.Header><Layout.Content className="content"><div className="heading"><div><Typography.Title heading={2}>{t.title}</Typography.Title><Typography.Text type="tertiary">Local-first Node.js development operations</Typography.Text></div><div className="import-actions"><Button theme="solid" icon={<IconSearch />}>{t.scan}</Button><Typography.Text type="tertiary">{t.scanHint}</Typography.Text></div></div><section className="metrics">{metrics.map((metric) => <div className={`metric ${metric.kind}`} key={metric.label}><b>{metric.value}</b><span>{metric.label}</span></div>)}</section><section className="workspace"><div className="panel"><Typography.Title heading={5}>CPU / Memory</Typography.Title><div className="chart"><i /><i /><i /><i /><i /><i /><i /><i /></div><Typography.Text type="tertiary">实时运行指标将在 daemon 接入后显示</Typography.Text></div><div className="panel logs"><div><Typography.Title heading={5}>{t.logs}</Typography.Title><Tag color="green">connected</Tag></div><code><em>[info]</em> dockyard-api ready on :4318<br/><em>[info]</em> PM2 ecosystem config detected<br/><strong>[warn]</strong> velora-admin crashed — inspect timeline<br/><em>[info]</em> watching 3 projects</code></div></section></Layout.Content></Layout></Layout></div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Dashboard /></StrictMode>);
