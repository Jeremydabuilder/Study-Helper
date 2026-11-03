import { useEffect, useState } from 'react';

/** A tiny toast: any My Helper page calls toast('Saved'); the shell shows it for a few seconds. */
export const toast = (text: string) => window.dispatchEvent(new CustomEvent('mh-toast', { detail: text }));
export function useToast() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const h = (e: Event) => { setText(String((e as CustomEvent).detail)); clearTimeout(t); t = setTimeout(() => setText(null), 3500); };
    window.addEventListener('mh-toast', h);
    return () => { window.removeEventListener('mh-toast', h); clearTimeout(t); };
  }, []);
  return text;
}
export const greeting = (name: string, d = new Date()) => `Good ${d.getHours() < 12 ? 'morning' : d.getHours() < 18 ? 'afternoon' : 'evening'}, ${name}`;
export const STAGES = ['Idea', 'Plan', 'Make', 'Test', 'Share'];
