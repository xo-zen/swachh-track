import { Suspense } from 'react';
import { Console } from '@/components/console';

export default function Page() { return <Suspense fallback={<div className="loading-state" role="status">Swachh-Track</div>}><Console /></Suspense>; }
