import { useState } from "react";
import TrainMap from "../components/TrainMap";
import NetworkStats from "../components/NetworkStats";
import TrainDetail from "../components/TrainDetail";

export default function LiveMap() {
  const [selectedTrain, setSelectedTrain] = useState<string | null>(null);

  return (
    <div className="relative h-full">
      <TrainMap onTrainClick={setSelectedTrain} />
      <div className="pointer-events-none absolute left-4 top-4">
        <NetworkStats />
      </div>
      {selectedTrain && (
        <TrainDetail trainCode={selectedTrain} onClose={() => setSelectedTrain(null)} />
      )}
    </div>
  );
}
