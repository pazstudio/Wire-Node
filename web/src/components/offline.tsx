import { useEffect, useState } from 'react';

/** Shown while the browser has no connection: pages opened before still show, changes cannot be saved. */
export function OfflineBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div className="offline-banner no-print" role="status">
      Offline: showing the copy saved on this device. Changes cannot be saved until the connection is back.
    </div>
  );
}
