import { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const nextId = useRef(0);

  const toast = useCallback((title, msg, cls = '') => {
    const id = ++nextId.current;
    setItems(v => [...v, { id, title, msg, cls, out: false }]);
    setTimeout(() => {
      setItems(v => v.map(t => (t.id === id ? { ...t, out: true } : t)));
      setTimeout(() => setItems(v => v.filter(t => t.id !== id)), 380);
    }, 4200);
  }, []);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="fixed bottom-6 right-6 z-300 flex flex-col gap-2.5 max-sm:left-4 max-sm:right-4">
        {items.map(t => (
          <div
            key={t.id}
            className={[
              'bg-panel2 border border-line2 border-l-[3px] rounded-xl py-3.5 px-4.5',
              'min-w-[280px] max-w-[360px] shadow-soft text-[13.5px]',
              'max-sm:max-w-none max-sm:min-w-0',
              t.cls === 'tup' ? 'border-l-up' : t.cls === 'tdown' ? 'border-l-down' : 'border-l-ace',
              t.out ? 'animate-toast-out' : 'animate-toast-in',
            ].join(' ')}
          >
            <b className="block font-display text-[13.5px] mb-0.5">{t.title}</b>
            <span className="text-muted text-[12.5px]">{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
