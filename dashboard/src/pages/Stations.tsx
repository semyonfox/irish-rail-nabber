import StationTable from "../components/StationTable";
import { Card, PageHeader } from "../components/ui";

export default function Stations() {
  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="Stations"
          title={
            <>
              Station <em>performance</em>
            </>
          }
          description="Delay statistics for every station on the network. Sort any column, or search by name or code."
        />
        <Card index={1}>
          <StationTable />
        </Card>
      </div>
    </div>
  );
}
