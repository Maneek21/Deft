'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ExperienceNode } from '@/lib/app-experience-bridge';
import { renderExperienceView, clearExperienceView, flushExperienceInputs } from '@/lib/app-experience-renderer';

/** The same bounded author view and governed event channel used by the app.
 * Settings never receives a second credential or an independent state store. */
export function ExperiencePreferences({ node, onEvent }: { node: ExperienceNode; onEvent: (event: unknown) => void }) {
  const host=useRef<HTMLDivElement>(null), latest=useRef(onEvent);
  useLayoutEffect(()=>{latest.current=onEvent;},[onEvent]);
  useEffect(()=>{if(host.current)renderExperienceView(host.current,{root:node},event=>latest.current(event));},[node]);
  useEffect(()=>{const element=host.current;return()=>{if(element){flushExperienceInputs(element);clearExperienceView(element);}};},[]);
  return <div className="deft-experience-preferences" ref={host} aria-label="App preferences" />;
}
