export const normalizePreparationDuration = (projectData: any) => {
  if (!Array.isArray(projectData?.subprojects)) {
    return projectData;
  }

  const subprojects = projectData.subprojects.map((subproject: any) => {
    const preparationValue = subproject?.preparationDuration?.value;
    if (preparationValue == null) {
      return subproject;
    }

    const preparationUnit =
      subproject?.preparationDuration?.unit ??
      subproject?.executionDuration?.unit ??
      "days";

    return {
      ...subproject,
      preparationDuration: {
        value: preparationValue,
        unit: preparationUnit,
      },
    };
  });

  return {
    ...projectData,
    subprojects,
  };
};
