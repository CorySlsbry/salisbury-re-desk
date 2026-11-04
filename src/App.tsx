import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { runBoot, type BootState } from './lib/boot';
import { startReminderLoop } from './lib/reminders';
import { getSettings } from './lib/repo';
import Today from './pages/Today';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import Calendar from './pages/Calendar';
import Packets from './pages/Packets';
import Intake from './pages/Intake';
import Settings from './pages/Settings';
import Engine from './pages/Engine';
import Tools from './pages/Tools';
import Audit from './pages/Audit';
import { startAutomationLoop } from './lib/automations';

/** Six places to be. Intake, Packets and Audit live under the section they belong to (still one click, still hot-keyed). */
const NAV: Array<{ to: string; label: string; hint: string; sub?: Array<[string, string]> }> = [
  { to: '/', label: 'Today', hint: 'What is due, what is at risk, who is waiting' },
  { to: '/engine', label: 'Daily Engine', hint: "Pat's non-negotiables, Monday to Friday" },
  { to: '/clients', label: 'Clients', hint: 'Every lead, client and file', sub: [['/intake', 'Intake a contract'], ['/packets', 'Packets and forms']] },
  { to: '/calendar', label: 'Calendar', hint: 'Deadlines, open houses, showings' },
  { to: '/tools', label: 'Tools', hint: 'CMA from an address, seller net sheet' },
  { to: '/settings', label: 'Settings', hint: 'Google, CRM, AI, backups', sub: [['/audit', 'Audit trail']] },
];

/** Ctrl+1..6 jump to the six sections; Ctrl+I Intake, Ctrl+P Packets, Ctrl+9 Audit. */
function Hotkeys() {
  const nav = useNavigate();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const idx = ['1', '2', '3', '4', '5', '6'].indexOf(e.key);
      if (idx >= 0) { e.preventDefault(); nav(NAV[idx].to); }
      if (e.key === '9') { e.preventDefault(); nav('/audit'); }
      if (e.key.toLowerCase() === 'i') { e.preventDefault(); nav('/intake'); }
      if (e.key.toLowerCase() === 'p') { e.preventDefault(); nav('/packets'); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [nav]);
  return null;
}

export default function App() {
  const [state, setState] = useState<BootState>({ ready: false, modelState: 'absent' });
  const [provider, setProvider] = useState<'local' | 'claude'>('local');
  useEffect(() => { void runBoot(setState); }, []);
  useEffect(() => { if (!state.ready) return; const stopReminders = startReminderLoop(); const stopAutomations = startAutomationLoop(); return () => { stopReminders(); stopAutomations(); }; }, [state.ready]);
  useEffect(() => {
    if (!state.ready) return;
    const read = () => getSettings().then(s => setProvider(s.ai_provider === 'claude' ? 'claude' : 'local')).catch(() => {});
    read(); const t = window.setInterval(read, 30_000); return () => window.clearInterval(t);
  }, [state.ready]);
  const aiLabel = provider === 'claude' ? 'AI: Claude on your subscription' : state.modelState === 'ready' ? 'AI: local model ready' : state.modelState === 'starting' ? 'AI: local model warming up' : state.modelState === 'absent' ? 'AI: model not downloaded' : 'AI: unavailable';
  const aiDot = provider === 'claude' || state.modelState === 'ready' ? 'bg-emerald-400' : state.modelState === 'starting' ? 'bg-amber-400 animate-pulse' : 'bg-white/30';
  return (
    <HashRouter>
      <Hotkeys />
      <div className="flex h-screen">
        <aside className="w-56 shrink-0 bg-ink text-paper flex flex-col">
          <div className="px-5 py-5 border-b border-white/10">
            <div className="text-lg font-semibold leading-tight">Salisbury RE Desk</div>
            <div className="text-xs text-white/60 mt-1">Simple Choice Real Estate</div>
          </div>
          <nav className="flex-1 px-2 py-3 space-y-0.5">
            {NAV.map((n, i) => (
              <div key={n.to}>
                <NavLink to={n.to} end={n.to === '/'} title={`${n.hint} (Ctrl+${i + 1})`}
                  className={({ isActive }) => `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand text-white' : 'text-white/80 hover:bg-white/10'}`}>
                  {n.label}
                </NavLink>
                {n.sub?.map(([to, label]) => (
                  <NavLink key={to} to={to} className={({ isActive }) => `block rounded-md py-1 pl-7 pr-3 text-xs ${isActive ? 'text-white' : 'text-white/55 hover:text-white/85'}`}>{label}</NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="px-4 py-3 text-xs text-white/60 border-t border-white/10">
            <div className="flex items-center gap-2"><span className={`inline-block h-2 w-2 rounded-full ${aiDot}`} /><span>{aiLabel}</span></div>
            {state.error && <div className="mt-1 text-amber-300 break-words">{state.error}</div>}
          </div>
        </aside>
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Today />} />
            <Route path="/engine" element={<Engine />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/:id" element={<ClientDetail />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/intake" element={<Intake />} />
            <Route path="/packets" element={<Packets />} />
            <Route path="/settings" element={<Settings boot={state} />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
