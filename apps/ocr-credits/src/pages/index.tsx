import { useAppBridge } from "@saleor/app-sdk/app-bridge";
import { Box, Text } from "@saleor/macaw-ui";
import { NextPage } from "next";

const IndexPage: NextPage = () => {
  const { appBridgeState } = useAppBridge();

  if (appBridgeState?.ready === false) {
    return (
      <Box padding={8}>
        <Text size={4} fontWeight="bold">
          Loading OCR Credits App...
        </Text>
      </Box>
    );
  }

  return (
    <Box padding={8}>
      <Text as="h1" size={8} fontWeight="bold" marginBottom={4}>
        OCR Credits
      </Text>
      <Text size={4} color="default2">
        This app automatically provisions OCR page credits when customers complete
        purchases on the OpenSensor OCR channel.
      </Text>
      <Box marginTop={6}>
        <Text size={3} fontWeight="bold">
          Supported Products:
        </Text>
        <Box as="ul" marginTop={2} marginLeft={4}>
          <li>OCR-2000: 2,000 pages ($20)</li>
          <li>OCR-5000: 5,000 pages ($45)</li>
          <li>OCR-10000: 10,000 pages ($80)</li>
          <li>OCR-25000: 25,000 pages ($175)</li>
        </Box>
      </Box>
      <Box marginTop={6}>
        <Text size={3} color="default2">
          Credits are automatically added to the customer&apos;s Demetered account
          using their email address when an order is fully paid.
        </Text>
      </Box>
    </Box>
  );
};

export default IndexPage;

