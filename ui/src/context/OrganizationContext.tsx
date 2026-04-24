import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Organization } from "@rudderhq/shared";
import { organizationsApi } from "../api/orgs";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import type { OrganizationSelectionSource } from "../lib/organization-selection";
type OrganizationSelectionOptions = { source?: OrganizationSelectionSource };

interface OrganizationContextValue {
  organizations: Organization[];
  selectedOrganizationId: string | null;
  selectedOrganization: Organization | null;
  selectionSource: OrganizationSelectionSource;
  loading: boolean;
  error: Error | null;
  setSelectedOrganizationId: (orgId: string, options?: OrganizationSelectionOptions) => void;
  reloadOrganizations: () => Promise<void>;
  createOrganization: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) => Promise<Organization>;
}

const STORAGE_KEY = "rudder.selectedOrganizationId";

const OrganizationContext = createContext<OrganizationContextValue | null>(null);

export function OrganizationProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectionSource, setSelectionSource] = useState<OrganizationSelectionSource>("bootstrap");
  const [selectedOrganizationId, setSelectedOrganizationIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  );

  const { data: organizations = [], isLoading, error } = useQuery({
    queryKey: queryKeys.organizations.all,
    queryFn: async () => {
      try {
        return await organizationsApi.list();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return [];
        }
        throw err;
      }
    },
    retry: false,
  });
  const sidebarOrganizations = useMemo(
    () => organizations.filter((organization) => organization.status !== "archived"),
    [organizations],
  );

  // Auto-select first organization when list loads
  useEffect(() => {
    if (organizations.length === 0) return;

    const selectableOrganizations = sidebarOrganizations.length > 0 ? sidebarOrganizations : organizations;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && selectableOrganizations.some((organization) => organization.id === stored)) return;
    if (selectedOrganizationId && selectableOrganizations.some((organization) => organization.id === selectedOrganizationId)) return;

    const next = selectableOrganizations[0]!.id;
    setSelectedOrganizationIdState(next);
    setSelectionSource("bootstrap");
    localStorage.setItem(STORAGE_KEY, next);
  }, [organizations, selectedOrganizationId, sidebarOrganizations]);

  const setSelectedOrganizationId = useCallback((orgId: string, options?: OrganizationSelectionOptions) => {
    setSelectedOrganizationIdState(orgId);
    setSelectionSource(options?.source ?? "manual");
    localStorage.setItem(STORAGE_KEY, orgId);
  }, []);

  const reloadOrganizations = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) =>
      organizationsApi.create(data),
    onSuccess: (organization) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
      setSelectedOrganizationId(organization.id);
    },
  });

  const createOrganization = useCallback(
    async (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) => {
      return createMutation.mutateAsync(data);
    },
    [createMutation],
  );

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === selectedOrganizationId) ?? null,
    [organizations, selectedOrganizationId],
  );

  const value = useMemo(
    () => ({
      organizations,
      selectedOrganizationId,
      selectedOrganization,
      selectionSource,
      loading: isLoading,
      error: error as Error | null,
      setSelectedOrganizationId,
      reloadOrganizations,
      createOrganization,
    }),
    [
      organizations,
      selectedOrganizationId,
      selectedOrganization,
      selectionSource,
      isLoading,
      error,
      setSelectedOrganizationId,
      reloadOrganizations,
      createOrganization,
    ],
  );

  return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
}

export function useOrganization() {
  const ctx = useContext(OrganizationContext);
  if (!ctx) {
    throw new Error("useOrganization must be used within OrganizationProvider");
  }
  return ctx;
}
