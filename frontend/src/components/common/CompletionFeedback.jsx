import React, { useEffect, useState } from 'react';
import { bookingsApi } from '../../api/client.js';

export default function CompletionFeedback({ booking }) {
  const [confirmed, setConfirmed] = useState(booking.customerConfirmedAt);
  const [rating, setRating] = useState(null);
  const [stars, setStars] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    bookingsApi.getRating(booking._id).then(result => {
      if (active) { setRating(result.data); setLoaded(true); }
    }).catch(err => {
      if (!active) return;
      if (err.code === 'RATING_NOT_FOUND') setLoaded(true);
      else setError(err.message);
    });
    return () => { active = false; };
  }, [booking._id, revision]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!confirmed) {
        const result = await bookingsApi.confirm(booking._id);
        setConfirmed(result.data.customerConfirmedAt);
      } else {
        const result = await bookingsApi.rate(booking._id, { rating: Number(stars), comment });
        setRating(result.data.rating);
      }
    } catch (err) {
      setError(err.message);
      if (err.code === 'DUPLICATE_RATING') setRevision(v => v + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="glass-panel p-6 space-y-4">
      <h2 className="font-bold text-lg">Service completion</h2>
      <p>{confirmed ? 'You confirmed this service was completed.' : 'Your technician marked the service complete.'}</p>
      {error && <p role="alert">{error} {!loaded && <button type="button" onClick={() => { setError(''); setRevision(v => v + 1); }}>Retry</button>}</p>}
      {rating && <p>Your rating · {rating.rating}/5 {rating.comment && '— ' + rating.comment}</p>}
      {confirmed && loaded && !rating && booking.technicianId && (
        <div className="space-y-3">
          <label className="block">Rate your technician
            <select className="block border rounded p-2" required value={stars} onChange={e => setStars(e.target.value)}>
              <option value="">Select a rating</option>
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} / 5</option>)}
            </select>
          </label>
          <label className="block">Comment (optional)
            <textarea className="block border rounded p-2 w-full" maxLength={500} value={comment} onChange={e => setComment(e.target.value)} />
          </label>
        </div>
      )}
      {(!confirmed || (loaded && !rating && booking.technicianId)) && (
        <button disabled={busy} className="glass-button-primary px-4 py-2">{confirmed ? 'Submit rating' : 'Confirm completion'}</button>
      )}
    </form>
  );
}
