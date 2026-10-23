import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

// 今日工时：只做页面跳转，直接打开协作平台的工时页面，不再在本地填写/提交。
const TIMESHEET_URL = "https://teamwork.cnhis.cc/#/layout/1836611827313680384";

export default function TimesheetEntry() {
  return (
    <Button variant="outline" asChild>
      <a href={TIMESHEET_URL} target="_blank" rel="noopener noreferrer">
        <Clock className="h-4 w-4" />
        今日工时
      </a>
    </Button>
  );
}
