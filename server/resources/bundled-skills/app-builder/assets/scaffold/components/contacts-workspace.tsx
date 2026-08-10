"use client";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Plus, Search, Trash2, Upload, UsersRound } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const statusVariant: Record<Contact["status"], "secondary" | "outline" | "success"> = {
  new: "secondary",
  contacted: "outline",
  replied: "success",
  paused: "outline",
};

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
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-card/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <UsersRound aria-hidden className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="m-0 truncate text-sm font-semibold">Pipeline Desk</p>
              <p className="m-0 text-xs text-muted-foreground">Local customer workspace</p>
            </div>
          </div>
          <Badge variant="outline">Development data</Badge>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:px-6">
        <section className="min-w-0">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="m-0 text-2xl font-semibold">Contacts</h1>
              <p className="mb-0 mt-1 text-sm text-muted-foreground">
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
                <Upload aria-hidden data-icon="inline-start" />
                Import
              </Button>
              <Button asChild variant="outline">
                <a href="/api/data/export" download>
                  <Download aria-hidden data-icon="inline-start" />
                  Export
                </a>
              </Button>
            </div>
          </div>

          <Card>
            <CardHeader className="sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>All contacts</CardTitle>
                <CardDescription>{contacts.length} {contacts.length === 1 ? "record" : "records"}</CardDescription>
              </div>
              <div className="relative w-full sm:w-64">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search contacts"
                  className="pl-9"
                  placeholder="Search contacts"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </CardHeader>
            <div aria-live="polite">
              {loading ? (
                <div className="flex flex-col gap-3 p-4" aria-label="Loading contacts">
                  {[0, 1, 2].map((item) => <Skeleton className="h-11 w-full" key={item} />)}
                </div>
              ) : visibleContacts.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{contacts.length === 0 ? "No contacts yet" : "No matching contacts"}</EmptyTitle>
                    <EmptyDescription>
                      {contacts.length === 0
                        ? "Add the first contact with the form beside this list."
                        : "Try a different name, email, company, or status."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Table className="table-fixed sm:min-w-[40rem] sm:table-auto">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Contact</TableHead>
                      <TableHead className="hidden sm:table-cell" scope="col">Company</TableHead>
                      <TableHead className="w-20 sm:w-auto" scope="col">Status</TableHead>
                      <TableHead aria-label="Actions" className="w-12 text-right sm:w-auto" scope="col">
                        <span className="hidden sm:inline">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleContacts.map((contact) => (
                      <TableRow key={contact.id}>
                        <TableCell>
                          <strong className="block font-medium">{contact.name}</strong>
                          <span className="block break-all text-muted-foreground sm:inline">{contact.email}</span>
                          <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
                            {contact.company || "Company not set"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">{contact.company || "Not set"}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant[contact.status]}>{contact.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            aria-label={`Delete ${contact.name}`}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                            onClick={() => void deleteContact(contact)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </Card>
        </section>

        <aside>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plus aria-hidden className="size-4" />
                Add contact
              </CardTitle>
              <CardDescription>Create a development record.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(event) => void createContact(event)}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="contact-name">Name</FieldLabel>
                    <Input
                      id="contact-name"
                      required
                      autoComplete="name"
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="contact-email">Email</FieldLabel>
                    <Input
                      id="contact-email"
                      required
                      autoComplete="email"
                      type="email"
                      value={draft.email}
                      onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="contact-company">Company</FieldLabel>
                    <Input
                      id="contact-company"
                      autoComplete="organization"
                      value={draft.company}
                      onChange={(event) => setDraft({ ...draft, company: event.target.value })}
                    />
                  </Field>
                  {error ? <Alert>{error}</Alert> : null}
                  <Button disabled={saving} type="submit">
                    {saving ? "Adding..." : "Add contact"}
                  </Button>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
}
