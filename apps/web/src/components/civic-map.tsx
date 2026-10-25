'use client';
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MapInstance } from 'maplibre-gl';
import { EmptyState } from '@swachh/ui';
import { number, record, text, type Row } from '@/lib/data';
import { boundaryGeometry } from '@/lib/map-data';
import { useI18n } from '@/lib/i18n';
import { Notice } from './operations';

export default function CivicMap({ societies, wards, reverseScale = false }: { societies: Row[]; wards: Row[]; reverseScale?: boolean }) {
  const { t } = useI18n(); const container = useRef<HTMLDivElement>(null); const map = useRef<MapInstance | null>(null); const [failed, setFailed] = useState(false);
  const points = societies.flatMap(society => { const lat = number(society.latitude); const lng = number(society.longitude); return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [{ id: text(society.id), name: text(society.name), lat, lng, coverage: number(society.coveragePct) }] : []; });
  const polygons = wards.flatMap(ward => {
    const geometry = boundaryGeometry(ward.boundary);
    if (!geometry) return [];
    const coverage = number(ward.coveragePct);
    return [{ type: 'Feature' as const, properties: { name: text(ward.name), ...(coverage === null ? {} : { coverage }) }, geometry }];
  });
  const locations: [number, number][] = [
    ...points.map<[number, number]>(point => [point.lng, point.lat]),
    ...polygons.flatMap(({ geometry }) => geometry.type === 'Polygon' ? geometry.coordinates.flat() : geometry.coordinates.flat(2))
      .map<[number, number]>(position => [position[0], position[1]]),
  ];
  const fingerprint = JSON.stringify({ points, polygons, reverseScale });
  useEffect(() => {
    if (!container.current || !locations.length) return;
    let view: MapInstance;
    try {
      view = new maplibregl.Map({ container: container.current, center: locations[0], zoom: 12, style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors', maxzoom: 19 } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] } });
    } catch { setFailed(true); return; }
    map.current = view; setFailed(false); view.addControl(new maplibregl.NavigationControl(), 'top-right');
    view.on('error', () => setFailed(true));
    view.on('load', () => {
      if (polygons.length) {
        view.addSource('wards', { type: 'geojson', data: { type: 'FeatureCollection', features: polygons } });
        view.addLayer({ id: 'ward-fill', type: 'fill', source: 'wards', paint: { 'fill-color': ['case', ['has', 'coverage'], ['interpolate', ['linear'], ['number', ['get', 'coverage']], 0, reverseScale ? '#13836a' : '#d48d68', 50, '#d6c774', 100, reverseScale ? '#d48d68' : '#13836a'], '#9ba8a1'], 'fill-opacity': 0.3 } });
        view.addLayer({ id: 'ward-outline', type: 'line', source: 'wards', paint: { 'line-color': '#375c50', 'line-width': 2 } });
      }
      view.addSource('societies', { type: 'geojson', cluster: true, clusterRadius: 48, clusterMaxZoom: 14, data: { type: 'FeatureCollection', features: points.map(point => ({ type: 'Feature', properties: { name: point.name, id: point.id }, geometry: { type: 'Point', coordinates: [point.lng, point.lat] } })) } });
      view.addLayer({ id: 'clusters', type: 'circle', source: 'societies', filter: ['has', 'point_count'], paint: { 'circle-color': '#08775d', 'circle-radius': ['step', ['get', 'point_count'], 20, 10, 25, 50, 31], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
      view.addLayer({ id: 'society-points', type: 'circle', source: 'societies', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': '#08775d', 'circle-radius': 9, 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });
      view.on('click', 'clusters', async event => { const feature = event.features?.[0]; if (!feature || feature.geometry.type !== 'Point') return; const source = view.getSource('societies') as GeoJSONSource; const clusterId = number(record(feature.properties).cluster_id); if (clusterId === null) return; try { const zoom = await source.getClusterExpansionZoom(clusterId); view.easeTo({ center: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]], zoom }); } catch { setFailed(true); } });
      view.on('click', 'society-points', event => { const feature = event.features?.[0]; if (!feature || feature.geometry.type !== 'Point') return; const content = document.createElement('strong'); content.textContent = text(record(feature.properties).name); new maplibregl.Popup().setLngLat([feature.geometry.coordinates[0], feature.geometry.coordinates[1]]).setDOMContent(content).addTo(view); });
      for (const layer of ['clusters', 'society-points']) { view.on('mouseenter', layer, () => { view.getCanvas().style.cursor = 'pointer'; }); view.on('mouseleave', layer, () => { view.getCanvas().style.cursor = ''; }); }
      if (locations.length > 1) { const bounds = new maplibregl.LngLatBounds(); locations.forEach(point => bounds.extend(point)); view.fitBounds(bounds, { padding: 50, maxZoom: 15 }); }
    });
    return () => { view.remove(); map.current = null; };
    // This serialized API snapshot avoids recreating the map during unrelated renders.
  }, [fingerprint]);
  if (!locations.length) return <EmptyState title={t('mapEmpty')} />;
  return <>{failed && <Notice>{t('mapError')}</Notice>}<div ref={container} className="civic-map" role="region" aria-label={t('map')} /></>;
}
