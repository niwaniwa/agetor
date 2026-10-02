import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Paths belong to the runner host, which may differ from this browser. */
export function ServerPathDialog({ open, title, initialPath, onClose, onSelect }: {
  open: boolean;
  title: string;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => Promise<void>;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPath(initialPath ?? ""); setError(null); } }, [open, initialPath]);
  if (!open) return null;
  return createPortal(<Dialog open={open} onClose={() => { if (!pending) onClose(); }} labelledBy={`${id}-title`} initialFocusRef={ref}>
    <form className="space-y-4 p-6" onSubmit={async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pending) return;
      setPending(true);
      setError(null);
      try { await onSelect(path.trim()); onClose(); }
      catch (e) { setError((e as Error).message); }
      finally { setPending(false); }
    }}>
      <h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">Enter an absolute path on the KANAME server.</p>
      <label htmlFor={`${id}-path`} className="block text-sm">Server directory</label>
      <Input ref={ref} id={`${id}-path`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/user/project" required />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending || !path.trim()}>{pending ? "Adding…" : "Add"}</Button>
      </div>
    </form>
  </Dialog>, document.body);
}
