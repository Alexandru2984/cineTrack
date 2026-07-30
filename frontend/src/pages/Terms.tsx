import { LegalDocument } from '@/components/LegalDocument';
import { useT } from '@/hooks/useT';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function TermsPage() {
  const t = useT();
  usePageTitle(t('legal.termsTitle'));

  return (
    <LegalDocument
      title={t('legal.termsTitle')}
      effective={t('legal.effective')}
      intro={t('legal.termsIntro')}
      contactLead={t('legal.contactTitle')}
      sections={[
        { title: t('legal.terms1Title'), body: t('legal.terms1Body') },
        { title: t('legal.terms2Title'), body: t('legal.terms2Body') },
        { title: t('legal.terms3Title'), body: t('legal.terms3Body') },
        { title: t('legal.terms4Title'), body: t('legal.terms4Body') },
        { title: t('legal.terms5Title'), body: t('legal.terms5Body') },
        { title: t('legal.terms6Title'), body: t('legal.terms6Body') },
        { title: t('legal.terms7Title'), body: t('legal.terms7Body') },
        { title: t('legal.terms8Title'), body: t('legal.terms8Body') },
        { title: t('legal.terms9Title'), body: t('legal.terms9Body') },
      ]}
    />
  );
}
