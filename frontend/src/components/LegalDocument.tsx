import { FileText, Mail, ShieldCheck } from 'lucide-react';

const CONTACT_EMAIL = 'postmaster@micutu.com';

interface LegalSection {
  title: string;
  body: string;
}

export function LegalDocument({
  title,
  effective,
  intro,
  sections,
  contactLead,
}: {
  title: string;
  effective: string;
  intro: string;
  sections: LegalSection[];
  contactLead: string;
}) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-[hsl(var(--border))] pb-7">
        <div className="flex items-center gap-2 text-[hsl(var(--primary))]">
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
          <span className="text-sm font-semibold">Văzute</span>
        </div>
        <h1 className="mt-3 text-2xl font-bold sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">{effective}</p>
        <p className="mt-5 text-sm leading-6 text-[hsl(var(--muted-foreground))]">{intro}</p>
      </header>

      <div className="divide-y divide-[hsl(var(--border))]">
        {sections.map((section) => (
          <section key={section.title} className="py-7">
            <h2 className="flex items-start gap-2 text-lg font-semibold">
              <FileText
                className="mt-0.5 h-5 w-5 shrink-0 text-[hsl(var(--primary))]"
                aria-hidden="true"
              />
              {section.title}
            </h2>
            <p className="mt-3 text-sm leading-6 text-[hsl(var(--muted-foreground))]">
              {section.body}
            </p>
          </section>
        ))}

        <section className="py-7">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Mail className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden="true" />
            {contactLead}
          </h2>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="mt-3 inline-block text-sm font-medium text-[hsl(var(--primary))] hover:underline"
          >
            {CONTACT_EMAIL}
          </a>
        </section>
      </div>
    </article>
  );
}
