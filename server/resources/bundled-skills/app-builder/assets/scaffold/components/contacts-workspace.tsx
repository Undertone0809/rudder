"use client";

import { Download, Plus, Search, Trash2, Upload } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Contact = {
  id: string;
  name: string;
  email: string;
  company: string;
  status: "new" | "contacted" | "replied" | "paused";
  createdAt: string;
  updatedAt: string;
};

type Draft = {
  name: string;
  email: string;
  company: string;
};

const emptyDraft: Draft = { name: "", email: "", company: "" };

export function ContactsWorkspace() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/contacts", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load contacts.");
      const body = await response.json() as { contacts: Contact[] };
      setContacts(body.contacts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load contacts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return contacts;
    return contacts.filter((contact) => (
      `${contact.name} ${contact.email} ${contact.company} ${contact.status}`
        .toLowerCase()
        .includes(normalized)
    ));
  }, [contacts, query]);

  async function createContact(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error === "invalid_contact"
          ? "Enter a name and a valid email address."
          : "Could not create the contact.");
      }
      setDraft(emptyDraft);
      await loadContacts();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the contact.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteContact(contact: Contact) {
    if (!window.confirm(`Delete ${contact.name}? This cannot be undone.`)) return;
    setError(null);
    const response = await fetch(`/api/contacts/${contact.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete the contact.");
      return;
    }
    setContacts((current) => current.filter((candidate) => candidate.id !== contact.id));
  }

  async function importData(file: File) {
    setError(null);
    try {
      const payload = JSON.parse(await file.text());
      const response = await fetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("The import file is invalid or incompatible.");
      await loadContacts();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not import this file.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:px-8">
      <section className="min-w-0">
        <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1 text-sm font-medium text-[var(--primary)]">Contacts</p>
            <h1 className="m-0 text-2xl font-semibold tracking-tight">Customer workspace</h1>
            <p className="mb-0 mt-2 text-sm text-[var(--muted-foreground)]">
              Keep the next conversation visible and every record on this device.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              ref={importRef}
              aria-label="Import app data"
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importData(file);
              }}
            />
            <Button type="button" variant="outline" onClick={() => importRef.current?.click()}>
              <Upload aria-hidden size={16} />
              Import
            </Button>
            <Button asChild variant="outline">
              <a href="/api/data/export" download>
                <Download aria-hidden size={16} />
                Export
              </a>
            </Button>
          </div>
        </header>

        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="m-0 text-base font-semibold">All contacts</h2>
              <p className="mb-0 mt-1 text-sm text-[var(--muted-foreground)]">
                {contacts.length} {contacts.length === 1 ? "record" : "records"}
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
                size={16}
              />
              <Input
                aria-label="Search contacts"
                className="pl-9"
                placeholder="Search name, email, company…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </CardHeader>
          <div aria-live="polite">
            {loading ? (
              <p className="p-8 text-center text-sm text-[var(--muted-foreground)]">
                Loading contacts…
              </p>
            ) : visibleContacts.length === 0 ? (
              <div className="p-10 text-center">
                <h3 className="m-0 text-base font-semibold">
                  {contacts.length === 0 ? "No contacts yet" : "No matching contacts"}
                </h3>
                <p className="mb-0 mt-2 text-sm text-[var(--muted-foreground)]">
                  {contacts.length === 0
                    ? "Add the first contact with the form beside this list."
                    : "Try a different name, email, company, or status."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
                  <thead className="bg-[var(--muted)] text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
                    <tr>
                      <th className="px-5 py-3 font-medium" scope="col">Contact</th>
                      <th className="px-5 py-3 font-medium" scope="col">Company</th>
                      <th className="px-5 py-3 font-medium" scope="col">Status</th>
                      <th className="px-5 py-3 text-right font-medium" scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleContacts.map((contact) => (
                      <tr className="border-t" key={contact.id}>
                        <td className="px-5 py-4">
                          <strong className="block font-medium">{contact.name}</strong>
                          <span className="text-[var(--muted-foreground)]">{contact.email}</span>
                        </td>
                        <td className="px-5 py-4">{contact.company || "—"}</td>
                        <td className="px-5 py-4">
                          <span className="rounded-full bg-[var(--muted)] px-2.5 py-1 text-xs font-medium capitalize">
                            {contact.status}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Button
                            aria-label={`Delete ${contact.name}`}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => void deleteContact(contact)}
                          >
                            <Trash2 aria-hidden size={16} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </section>

      <aside>
        <Card>
          <CardHeader>
            <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
              <Plus aria-hidden size={18} />
              Add contact
            </h2>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={(event) => void createContact(event)}>
              <div className="grid gap-1.5">
                <Label htmlFor="contact-name">Name</Label>
                <Input
                  id="contact-name"
                  required
                  autoComplete="name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="contact-email">Email</Label>
                <Input
                  id="contact-email"
                  required
                  autoComplete="email"
                  type="email"
                  value={draft.email}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="contact-company">Company</Label>
                <Input
                  id="contact-company"
                  autoComplete="organization"
                  value={draft.company}
                  onChange={(event) => setDraft({ ...draft, company: event.target.value })}
                />
              </div>
              {error ? (
                <p className="m-0 text-sm text-[var(--destructive)]" role="alert">{error}</p>
              ) : null}
              <Button disabled={saving} type="submit">
                {saving ? "Adding…" : "Add contact"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
