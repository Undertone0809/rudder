import * as React from "react";
import * as RouterDom from "react-router-dom";
import type { NavigateOptions, To } from "react-router-dom";
import { useOrganization } from "@/context/OrganizationContext";
import {
  applyOrganizationPrefix,
  extractOrganizationPrefixFromPath,
  normalizeOrganizationPrefix,
} from "@/lib/organization-routes";

function resolveTo(to: To, orgPrefix: string | null): To {
  if (typeof to === "string") {
    return applyOrganizationPrefix(to, orgPrefix);
  }

  if (to.pathname && to.pathname.startsWith("/")) {
    const pathname = applyOrganizationPrefix(to.pathname, orgPrefix);
    if (pathname !== to.pathname) {
      return { ...to, pathname };
    }
  }

  return to;
}

function useActiveCompanyPrefix(): string | null {
  const { selectedOrganization } = useOrganization();
  const params = RouterDom.useParams<{ orgPrefix?: string }>();
  const location = RouterDom.useLocation();

  if (params.orgPrefix) {
    return normalizeOrganizationPrefix(params.orgPrefix);
  }

  const pathPrefix = extractOrganizationPrefixFromPath(location.pathname);
  if (pathPrefix) return pathPrefix;

  return selectedOrganization ? normalizeOrganizationPrefix(selectedOrganization.issuePrefix) : null;
}

export * from "react-router-dom";

export const Link = React.forwardRef<HTMLAnchorElement, React.ComponentProps<typeof RouterDom.Link>>(
  function CompanyLink({ to, draggable = false, ...props }, ref) {
    const orgPrefix = useActiveCompanyPrefix();
    return <RouterDom.Link ref={ref} to={resolveTo(to, orgPrefix)} draggable={draggable} {...props} />;
  },
);

export const NavLink = React.forwardRef<HTMLAnchorElement, React.ComponentProps<typeof RouterDom.NavLink>>(
  function CompanyNavLink({ to, draggable = false, ...props }, ref) {
    const orgPrefix = useActiveCompanyPrefix();
    return <RouterDom.NavLink ref={ref} to={resolveTo(to, orgPrefix)} draggable={draggable} {...props} />;
  },
);

export function Navigate({ to, ...props }: React.ComponentProps<typeof RouterDom.Navigate>) {
  const orgPrefix = useActiveCompanyPrefix();
  return <RouterDom.Navigate to={resolveTo(to, orgPrefix)} {...props} />;
}

export function useNavigate(): ReturnType<typeof RouterDom.useNavigate> {
  const navigate = RouterDom.useNavigate();
  const orgPrefix = useActiveCompanyPrefix();

  return React.useCallback(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === "number") {
        navigate(to);
        return;
      }
      navigate(resolveTo(to, orgPrefix), options);
    }) as ReturnType<typeof RouterDom.useNavigate>,
    [navigate, orgPrefix],
  );
}
