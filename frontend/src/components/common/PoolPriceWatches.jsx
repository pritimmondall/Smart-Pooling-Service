import React, { useEffect, useState } from 'react';
import { bookingsApi } from '../../api/client.js';

export default function PoolPriceWatches({ request }) {
  const [items, setItems] = useState([]);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    async function refresh() {
      try {
        const res = await bookingsApi.watches();
        if (active) setItems(res.data);
      } catch (err) { if (active) setMessage(err.message); }
    }
    refresh();
    return () => { active = false; };
  }, [open, busy]);

  async function change(id) {
    setBusy(true);
    try {
      if (id) await bookingsApi.removeWatch(id);
      else await bookingsApi.watch({ ...request, maxPrice: Number(price) });
      setMessage(id ? 'Watch removed.' : 'Watch saved. Check Notifications for your match.');
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  return <details className="border-t mt-4 pt-3" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="pool-secondary cursor-pointer">Watch for a price</summary>
    <p className="text-sm my-2">Get one in-app alert when an automatic pool matches your service, pin, time window and price.</p>
    {request ? <form onSubmit={e => { e.preventDefault(); change(); }} className="space-y-2">
      <label>Alert me at or below (₹)<input required type="number" min="0.01" step="0.01" className="glass-input w-full" value={price} onChange={e => setPrice(e.target.value)}/></label>
      <button disabled={busy} className="pool-secondary">Save price watch</button>
    </form> : <p className="text-sm">Select a service, location and future time window above.</p>}
    {message && <p role="status">{message}</p>}
    {items.map(watch => <div key={watch._id} className="mt-2 text-sm">
      {watch.specificService} · up to ₹{watch.maxPrice} · {new Date(watch.start).toLocaleString()} – {new Date(watch.end).toLocaleTimeString()}
      <button type="button" className="pool-secondary ml-2" disabled={busy} onClick={() => change(watch._id)}>Remove</button>
    </div>)}
  </details>;
}
