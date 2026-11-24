import { useEffect, useState } from 'react';
import { poolsApi } from '../../api/client.js';

export default function useNearbyPools(params) {
  const key = JSON.stringify(params);
  const [result, setResult] = useState({});
  useEffect(() => {
    if (key === 'null') return;
    let active = true;
    async function refresh() {
      try {
        const res = await poolsApi.nearby(JSON.parse(key));
        if (active) setResult({ key, items: res.data, needsLocation: res.meta?.needsLocation });
      } catch (err) {
        if (active) setResult({ key, error: err.message });
      }
    }
    const initial = setTimeout(refresh, 180);
    const timer = setInterval(refresh, 15000);
    return () => { active = false; clearTimeout(initial); clearInterval(timer); };
  }, [key]);
  if (params == null) return { loading: false };
  return result.key === key ? result : { loading: true };
}
