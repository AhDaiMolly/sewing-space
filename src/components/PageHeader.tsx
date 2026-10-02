interface PageHeaderProps {
  title: string;
}

export default function PageHeader({ title }: PageHeaderProps) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
    </div>
  );
}